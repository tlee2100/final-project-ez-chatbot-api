import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bull';
import { Repository } from 'typeorm';
import { Document } from './entities/document.entity';
import { DocumentStatus } from './enums/document-status.enum';
import type {
  DocumentProcessingJobData,
  DocumentReindexJobData,
} from './types/document-processing-job.type';
import { BadRequestException, Logger } from '@nestjs/common';
import { NotificationGateway } from 'src/notification/notification.gateway';
import { NotificationService } from 'src/notification/notification.service';
import { NotificationType } from 'src/notification/enums/notification-type.enum';
import { DocumentService } from './document.service';
import { DocumentContextValidator } from './validators/document-context.validator';
import { DocumentChunkingService } from './chunking/document-chunking.service';
import { EmbeddingService } from './embedding/embedding.service';
import { DocumentIngestionService } from './document-ingestion.service';
import { DocumentReindexStatus } from './enums/document-reindex-status.enum';
import {
  DOCUMENT_CHUNK_MAX_TOKENS,
  DOCUMENT_CHUNK_OVERLAP_TOKENS,
} from './constants/document-chunking.constants';

@Processor('document-processing')
export class DocumentProcessingWorker {
  private readonly logger = new Logger(DocumentProcessingWorker.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    private readonly documentService: DocumentService,
    private readonly documentChunkingService: DocumentChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly documentIngestionService: DocumentIngestionService,
    private readonly notificationGateway: NotificationGateway,
    private readonly notificationService: NotificationService,
  ) {}

  @Process('process-document')
  async handleProcessDocument(job: Job<DocumentProcessingJobData>) {
    const { documentId, filename, fileBufferBase64, uploadedByUserId } =
      job.data;
    const chunkSize = job.data.chunkSize ?? DOCUMENT_CHUNK_MAX_TOKENS;
    const chunkOverlap = job.data.chunkOverlap ?? DOCUMENT_CHUNK_OVERLAP_TOKENS;

    this.logger.log(`Processing document ${documentId} (${filename})`);

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
    const siteId = document.siteId;
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

      const sanitizedContent = validationResult.sanitizedContent?.trim();
      if (!sanitizedContent) {
        throw new BadRequestException(
          'Document does not contain text that can be embedded',
        );
      }

      // 3. Chunk content and generate vectors before storing the source asset.
      const chunks = this.documentChunkingService.chunk(
        sanitizedContent,
        validationResult.fileType,
        { chunkSize, chunkOverlap },
      );
      const embeddingResult = await this.embeddingService.embedMany(
        chunks.map((chunk) => chunk.content),
      );

      // 4. Upload the validated source file after embeddings are ready.
      const uploadResult = await this.documentService.uploadBufferToCloudinary(
        buffer,
        filename,
        siteId,
      );

      createdCloudinaryPublicId = uploadResult.public_id;

      // 5. Atomically persist chunks and mark the source document as ready.
      const processedAt = new Date();
      await this.documentIngestionService.persistProcessedDocument({
        documentId,
        chunks,
        embeddingResult,
        filePath: uploadResult.secure_url,
        cloudinaryPublicId: uploadResult.public_id,
        processedAt,
        chunkSize,
        chunkOverlap,
      });

      // 6. Emit success only after the persistence transaction has committed.
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

  @Process('reindex-document')
  async handleReindexDocument(job: Job<DocumentReindexJobData>): Promise<void> {
    const { documentId, uploadedByUserId, chunkSize, chunkOverlap } = job.data;
    const document = await this.documentRepository.findOne({
      where: { id: documentId, siteId: job.data.siteId },
    });
    if (!document) return;

    try {
      await this.documentRepository.update(document.id, {
        reindexStatus: DocumentReindexStatus.PROCESSING,
        reindexError: null,
      });
      this.notificationGateway.emitDocumentStatusToUsers([uploadedByUserId], {
        type: 'document-reindex-processing',
        documentId,
        filename: document.filename,
        status: 'processing',
      });

      if (!document.cloudinaryPublicId) {
        throw new BadRequestException('Original file is unavailable');
      }
      const buffer = await this.documentService.downloadCloudinaryAsset(
        document.cloudinaryPublicId,
      );
      const validationResult =
        await DocumentContextValidator.validateAndExtractContent(
          buffer,
          document.filename,
        );
      const sanitizedContent = validationResult.sanitizedContent?.trim();
      if (!sanitizedContent) {
        throw new BadRequestException(
          'Document does not contain text that can be embedded',
        );
      }

      const chunks = this.documentChunkingService.chunk(
        sanitizedContent,
        validationResult.fileType,
        { chunkSize, chunkOverlap },
      );
      const embeddingResult = await this.embeddingService.embedMany(
        chunks.map((chunk) => chunk.content),
      );
      const processedAt = new Date();
      await this.documentIngestionService.persistProcessedDocument({
        documentId,
        chunks,
        embeddingResult,
        filePath: document.filePath ?? '',
        cloudinaryPublicId: document.cloudinaryPublicId,
        processedAt,
        chunkSize,
        chunkOverlap,
        replaceExisting: true,
      });

      this.notificationGateway.emitDocumentStatusToUsers([uploadedByUserId], {
        type: 'document-reindex-ready',
        documentId,
        filename: document.filename,
        status: 'ready',
        processedAt: processedAt.toISOString(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown re-index error';
      this.logger.error(
        `Re-index failed for document ${documentId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.documentRepository.update(documentId, {
        reindexStatus: DocumentReindexStatus.FAILED,
        reindexError: errorMessage.slice(0, 2000),
      });
      this.notificationGateway.emitDocumentStatusToUsers([uploadedByUserId], {
        type: 'document-reindex-failed',
        documentId,
        filename: document.filename,
        status: 'failed',
        error: errorMessage,
      });
    }
  }
}
