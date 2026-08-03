import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bull';
import { Repository } from 'typeorm';
import { Document } from './entities/document.entity';
import { DocumentStatus } from './enums/document-status.enum';
import type { DocumentProcessingJobData } from './types/document-processing-job.type';
import { Logger } from '@nestjs/common';
import { NotificationGateway } from 'src/notification/notification.gateway';
import { NotificationService } from 'src/notification/notification.service';
import { NotificationType } from 'src/notification/enums/notification-type.enum';
import { DocumentService } from './document.service';
import { DocumentContextValidator } from './validators/document-context.validator';

@Processor('document-processing')
export class DocumentProcessingWorker {
  private readonly logger = new Logger(DocumentProcessingWorker.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    private readonly documentService: DocumentService,
    private readonly notificationGateway: NotificationGateway,
    private readonly notificationService: NotificationService,
  ) {}

  @Process('process-document')
  async handleProcessDocument(job: Job<DocumentProcessingJobData>) {
    const { documentId, filename, fileBufferBase64, uploadedByUserId, siteId } =
      job.data;

    this.logger.log(
      `Processing document ${documentId} (${filename}) for site ${siteId}`,
    );

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });

    if (!document) {
      this.logger.warn(
        `Document record not found for processing: ${documentId}`,
      );
      return;
    }

    const notificationUserIds = [uploadedByUserId];
    let createdCloudinaryPublicId: string | null = null;

    try {
      // 1. Update status to PROCESSING and emit WS event
      await this.documentRepository.update(documentId, {
        status: DocumentStatus.PROCESSING,
      });
      this.notificationGateway.emitDocumentStatusToUsers(notificationUserIds, {
        type: 'document-processing',
        documentId,
        filename: document.filename,
        status: 'processing',
      });

      // 2. Decode Buffer & Validate Content/Context (PDF, DOCX, TXT, MD, HTML Sanitization)
      const buffer = Buffer.from(fileBufferBase64, 'base64');
      const validationResult =
        await DocumentContextValidator.validateAndExtractContent(
          buffer,
          filename,
        );

      this.logger.log(
        `Document ${documentId} validated successfully as '${validationResult.fileType}'. Content length: ${validationResult.sanitizedContent?.length || 0}`,
      );

      // 3. Option B: Upload to Cloudinary AFTER text extraction & validation success
      const uploadResult = await this.documentService.uploadBufferToCloudinary(
        buffer,
        filename,
        siteId,
      );

      createdCloudinaryPublicId = uploadResult.public_id;

      // 4. Update Document status to READY with Cloudinary URL & metadata
      const processedAt = new Date();
      await this.documentRepository.update(documentId, {
        filePath: uploadResult.secure_url,
        cloudinaryPublicId: uploadResult.public_id,
        status: DocumentStatus.READY,
        processedAt,
      });

      // 5. Emit WebSocket document-ready and save notification DB record
      this.notificationGateway.emitDocumentStatusToUsers(notificationUserIds, {
        type: 'document-ready',
        documentId,
        filename: document.filename,
        status: 'ready',
        processedAt: processedAt.toISOString(),
      });

      await this.notificationService.create({
        recipientId: uploadedByUserId,
        siteId: siteId,
        type: NotificationType.DOCUMENT_PROCESSED,
        title: 'Document Processing Complete',
        message: `Your document '${filename}' has been successfully processed and is ready.`,
      });

      this.logger.log(
        `Successfully processed and uploaded document ${documentId}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown document processing error';
      this.logger.error(
        `Processing failed for document ${documentId}. Triggering Hard Delete Rollback. Reason: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      // HARD DELETE ROLLBACK: Clean up Cloudinary asset if created & delete DB record
      if (createdCloudinaryPublicId) {
        await this.documentService.deleteCloudinaryAsset(
          createdCloudinaryPublicId,
        );
      }

      await this.documentRepository.delete(documentId);

      // Emit WebSocket failure notification
      this.notificationGateway.emitDocumentStatusToUsers(notificationUserIds, {
        type: 'document-failed',
        documentId,
        filename: document.filename,
        status: 'failed',
        error: errorMessage,
      });

      await this.notificationService.create({
        recipientId: uploadedByUserId,
        siteId: siteId,
        type: NotificationType.SYSTEM,
        title: 'Document Processing Failed',
        message: `Failed to process document '${filename}': ${errorMessage}`,
      });
    }
  }
}
