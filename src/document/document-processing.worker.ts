import { Process, Processor } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bull';
import { Repository } from 'typeorm';
import { Document } from './entities/document.entity';
import { DocumentStatus } from './enums/document-status.enum';
import type { DocumentProcessingJobData } from './types/document-processing-job.type';
import { Logger } from '@nestjs/common';
import { ChatGateway } from 'src/chat/chat.gateway';

@Processor('document-processing')
export class DocumentProcessingWorker {
  private readonly logger = new Logger(DocumentProcessingWorker.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Process('process-document')
  async handleProcessDocument(job: Job<DocumentProcessingJobData>) {
    const { documentId, filePath, uploadedByUserId } = job.data;
    this.logger.log(`filePath: ${filePath}`);

    const document = await this.documentRepository.findOne({
      where: { id: documentId },
    });

    if (!document) {
      this.logger.warn(`Document not found for processing: ${documentId}`);
      return;
    }

    const notificationUserIds = [uploadedByUserId];

    await this.documentRepository.update(documentId, {
      status: DocumentStatus.PROCESSING,
    });
    this.chatGateway.emitDocumentStatusToUsers(notificationUserIds, {
      type: 'document-processing',
      documentId,
      filename: document.filename,
      status: 'processing',
    });

    await new Promise((resolve) => setTimeout(resolve, 7000));

    const processedAt = new Date();

    await this.documentRepository.update(documentId, {
      status: DocumentStatus.READY,
      processedAt,
    });
    this.chatGateway.emitDocumentStatusToUsers(notificationUserIds, {
      type: 'document-ready',
      documentId,
      filename: document.filename,
      status: 'ready',
      processedAt: processedAt.toISOString(),
    });
  }
}
