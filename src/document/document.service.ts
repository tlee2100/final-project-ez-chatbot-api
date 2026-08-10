import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { paginate, type Paginated, type PaginateQuery } from 'nestjs-paginate';
import { Document } from './entities/document.entity';
import { DocumentChunk } from './entities/document-chunk.entity';
import { Site } from '../site/entities/site.entity';
import { DocumentStatus } from './enums/document-status.enum';
import {
  DocumentFileType,
  EXTENSION_TO_FILE_TYPE,
} from './enums/document-file-type.enum';
import { DOCUMENT_PAGINATION_CONFIG } from './config/document-pagination.config';
import type { DocumentProcessingJobData } from './types/document-processing-job.type';
import type { JwtUser } from 'src/auth/types/jwt-user.type';

import { DocumentContextValidator } from './validators/document-context.validator';
import { DOCUMENT_VECTOR_LIMIT } from './constants/document-storage.constants';

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,

    @InjectRepository(DocumentChunk)
    private readonly documentChunkRepository: Repository<DocumentChunk>,

    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,

    @InjectQueue('document-processing')
    private readonly documentQueue: Queue<DocumentProcessingJobData>,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  async getSiteDocuments(
    siteId: string,
    query: PaginateQuery,
    user: JwtUser,
  ): Promise<Paginated<Document>> {
    await this.findOwnedSiteOrThrow(siteId, user);

    const queryBuilder = this.documentRepository
      .createQueryBuilder('doc')
      .where('doc.siteId = :siteId', { siteId });

    return paginate(query, queryBuilder, DOCUMENT_PAGINATION_CONFIG);
  }

  async uploadDocument(
    siteId: string,
    file: Express.Multer.File,
    uploadedByUser: JwtUser,
  ) {
    await this.findOwnedSiteOrThrow(siteId, uploadedByUser);

    // Validate file header, extension, and magic bytes synchronously before DB/Queue
    DocumentContextValidator.validateHeaderAndExtension(file);

    const ext = file.originalname.split('.').pop()?.toLowerCase() || '';
    const fileType = EXTENSION_TO_FILE_TYPE.get(ext) || DocumentFileType.TXT;

    let savedDocument: Document;

    try {
      const document = this.documentRepository.create({
        filename: file.originalname,
        filePath: 'pending',
        fileType,
        fileSizeBytes: file.size,
        cloudinaryPublicId: null,
        status: DocumentStatus.PENDING,
        siteId,
        uploadedAt: new Date(),
      });

      savedDocument = await this.documentRepository.save(document);
    } catch (error) {
      this.logger.error(
        'Failed to save uploaded document metadata to database',
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        'Failed to save uploaded document metadata',
      );
    }

    // Option B: Enqueue Job with Buffer to Bull Worker (Worker will parse & upload to Cloudinary)
    const jobData: DocumentProcessingJobData = {
      documentId: savedDocument.id,
      filename: file.originalname,
      fileBufferBase64: file.buffer.toString('base64'),
      uploadedByUserId: uploadedByUser.id,
      siteId,
    };

    try {
      await this.documentQueue.add('process-document', jobData, {
        jobId: savedDocument.id,
        attempts: 1, // Job failure triggers Hard Delete Rollback in worker
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (error) {
      // Hard delete rollback if queue enqueue fails
      await this.documentRepository.delete(savedDocument.id);
      this.logger.error(
        `Failed to enqueue document processing job for document ${savedDocument.id}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        'Failed to enqueue document processing job',
      );
    }

    return savedDocument;
  }

  async deleteDocument(
    siteId: string,
    documentId: string,
    user: JwtUser,
  ): Promise<{ message: string; id: string }> {
    await this.findOwnedSiteOrThrow(siteId, user);

    const document = await this.documentRepository.findOne({
      where: { id: documentId, siteId },
    });

    if (!document) {
      throw new NotFoundException(
        `Document with ID '${documentId}' not found for this site`,
      );
    }

    // 1. Delete asset from Cloudinary
    if (document.cloudinaryPublicId) {
      await this.deleteCloudinaryAsset(document.cloudinaryPublicId);
    }

    // 2. Hard delete record from Database
    await this.documentRepository.remove(document);

    this.logger.log(
      `Document ${documentId} deleted successfully from DB and Cloudinary`,
    );

    return {
      message: 'Document deleted successfully',
      id: documentId,
    };
  }

  async findOwnedSiteOrThrow(siteId: string, user: JwtUser): Promise<Site> {
    const site = await this.siteRepository.findOne({
      where: { id: siteId },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    if (site.ownerId !== user.id) {
      throw new ForbiddenException(
        'Only the site owner or administrator is permitted to manage documents for this site',
      );
    }

    return site;
  }

  async deleteCloudinaryAsset(publicId: string | null): Promise<void> {
    if (!publicId) {
      return;
    }

    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'raw',
      });
      this.logger.log(`Deleted Cloudinary asset: ${publicId}`);
    } catch (error) {
      this.logger.error(
        `Failed to delete Cloudinary asset ${publicId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  uploadBufferToCloudinary(
    buffer: Buffer,
    filename: string,
    siteId: string,
  ): Promise<UploadApiResponse> {
    const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } =
      process.env;

    if (
      !CLOUDINARY_CLOUD_NAME ||
      !CLOUDINARY_API_KEY ||
      !CLOUDINARY_API_SECRET
    ) {
      throw new InternalServerErrorException(
        'Cloudinary environment variables are missing',
      );
    }

    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: `sites/${siteId}/documents`,
          public_id: `${Date.now()}-${filename}`,
          resource_type: 'raw',
        },
        (error, result) => {
          if (error) {
            const uploadError: Error =
              error instanceof Error
                ? error
                : new Error(
                    typeof error.message === 'string'
                      ? error.message
                      : 'Cloudinary upload failed',
                  );
            reject(uploadError);
            return;
          }

          if (!result) {
            reject(new Error('Cloudinary upload failed'));
            return;
          }

          resolve(result);
        },
      );

      uploadStream.end(buffer);
    });
  }

  async getDocumentChunks(
    siteId: string,
    documentId: string,
    user: JwtUser,
  ): Promise<{
    document: {
      id: string;
      filename: string;
      fileType: DocumentFileType;
      fileSizeBytes: number | null;
      status: DocumentStatus;
      filePath: string;
      uploadedAt: Date;
      processedAt: Date | null;
      chunksCount: number;
    };
    chunks: Array<{
      id: string;
      chunkIndex: number;
      content: string;
      tokenCount: number;
      sectionTitle: string | null;
      metadata: Record<string, unknown>;
      embeddingModel: string;
      vectorDimensions: number;
      createdAt: Date;
    }>;
  }> {
    await this.findOwnedSiteOrThrow(siteId, user);

    const document = await this.documentRepository.findOne({
      where: { id: documentId, siteId },
    });

    if (!document) {
      throw new NotFoundException(
        `Document with ID '${documentId}' not found for this site`,
      );
    }

    const chunks = await this.documentChunkRepository.find({
      where: { documentId, siteId },
      order: { chunkIndex: 'ASC' },
      select: {
        id: true,
        documentId: true,
        siteId: true,
        chunkIndex: true,
        content: true,
        tokenCount: true,
        sectionTitle: true,
        metadata: true,
        embeddingModel: true,
        createdAt: true,
      },
    });

    return {
      document: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        fileSizeBytes: document.fileSizeBytes,
        status: document.status,
        filePath: document.filePath,
        uploadedAt: document.uploadedAt,
        processedAt: document.processedAt,
        chunksCount: chunks.length,
      },
      chunks: chunks.map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        sectionTitle: chunk.sectionTitle,
        metadata: chunk.metadata,
        embeddingModel: chunk.embeddingModel,
        vectorDimensions: 1536,
        createdAt: chunk.createdAt,
      })),
    };
  }

  async getSiteKBStats(
    siteId: string,
    user: JwtUser,
  ): Promise<{
    totalDocuments: number;
    totalChunks: number;
    totalSizeBytes: number;
    totalTokens: number;
    vectorsUsed: number;
    vectorsLimit: number;
    usagePercentage: number;
    lastProcessedAt: Date | null;
  }> {
    await this.findOwnedSiteOrThrow(siteId, user);

    const totalDocuments = await this.documentRepository.count({
      where: { siteId },
    });

    const totalChunks = await this.documentChunkRepository.count({
      where: { siteId },
    });

    interface SizeQueryResult {
      totalSize?: string | number | null;
      lastProcessedAt?: string | Date | null;
    }

    interface TokenQueryResult {
      totalTokens?: string | number | null;
    }

    const sizeResult = await this.documentRepository
      .createQueryBuilder('doc')
      .select('SUM(doc.fileSizeBytes)', 'totalSize')
      .addSelect('MAX(doc.processedAt)', 'lastProcessedAt')
      .where('doc.siteId = :siteId', { siteId })
      .getRawOne<SizeQueryResult>();

    const tokenResult = await this.documentChunkRepository
      .createQueryBuilder('chunk')
      .select('SUM(chunk.tokenCount)', 'totalTokens')
      .where('chunk.siteId = :siteId', { siteId })
      .getRawOne<TokenQueryResult>();

    const totalSizeBytes = Number(sizeResult?.totalSize) || 0;
    const totalTokens = Number(tokenResult?.totalTokens) || 0;
    const lastProcessedAt = sizeResult?.lastProcessedAt
      ? new Date(sizeResult.lastProcessedAt)
      : null;
    const vectorsUsed = totalChunks;
    const vectorsLimit = DOCUMENT_VECTOR_LIMIT;
    const usagePercentage = Number(
      ((vectorsUsed / vectorsLimit) * 100).toFixed(2),
    );

    return {
      totalDocuments,
      totalChunks,
      totalSizeBytes,
      totalTokens,
      vectorsUsed,
      vectorsLimit,
      usagePercentage,
      lastProcessedAt,
    };
  }
}
