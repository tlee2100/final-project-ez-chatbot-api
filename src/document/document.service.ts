import {
  BadRequestException,
  ConflictException,
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
import axios from 'axios';
import { paginate, type PaginateQuery } from 'nestjs-paginate';
import { Document } from './entities/document.entity';
import { DocumentChunk } from './entities/document-chunk.entity';
import { Site } from '../site/entities/site.entity';
import { DocumentStatus } from './enums/document-status.enum';
import {
  DocumentFileType,
  EXTENSION_TO_FILE_TYPE,
} from './enums/document-file-type.enum';
import { DOCUMENT_PAGINATION_CONFIG } from './config/document-pagination.config';
import type {
  DocumentProcessingJobData,
  DocumentReindexJobData,
} from './types/document-processing-job.type';
import type { JwtUser } from 'src/auth/types/jwt-user.type';
import { UserRole } from '../user/enums/user-role.enum';

import { DocumentContextValidator } from './validators/document-context.validator';
import { DOCUMENT_VECTOR_LIMIT } from './constants/document-storage.constants';
import { DocumentReindexStatus } from './enums/document-reindex-status.enum';
import { DocumentSourceKind } from '../crawler/enums/crawler.enums';
import type { UpdateKnowledgeBaseSettingsDto } from './dto/knowledge-base-settings.dto';
import { DOCUMENT_MAX_FILE_SIZE } from './constants/document-upload.constants';

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
    private readonly documentQueue: Queue<
      DocumentProcessingJobData | DocumentReindexJobData
    >,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  async getSiteDocuments(siteId: string, query: PaginateQuery, user: JwtUser) {
    const site = await this.findOwnedSiteOrThrow(siteId, user);

    const queryBuilder = this.documentRepository
      .createQueryBuilder('doc')
      .where('doc.siteId = :siteId', { siteId });

    const result = await paginate(
      query,
      queryBuilder,
      DOCUMENT_PAGINATION_CONFIG,
    );
    return {
      ...result,
      data: result.data.map((document) => ({
        ...document,
        needsReindex: this.needsReindex(document, site),
      })),
    };
  }

  async uploadDocument(
    siteId: string,
    file: Express.Multer.File,
    uploadedByUser: JwtUser,
  ) {
    const site = await this.findOwnedSiteOrThrow(siteId, uploadedByUser);

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
      chunkSize: site.kbChunkSize,
      chunkOverlap: site.kbChunkOverlap,
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

  async getKnowledgeBaseSettings(siteId: string, user: JwtUser) {
    const site = await this.findOwnedSiteOrThrow(siteId, user);
    return this.toKnowledgeBaseSettings(site);
  }

  async updateKnowledgeBaseSettings(
    siteId: string,
    dto: UpdateKnowledgeBaseSettingsDto,
    user: JwtUser,
  ) {
    const site = await this.findOwnedSiteOrThrow(siteId, user);
    const chunkSize = dto.chunkSize ?? site.kbChunkSize;
    const chunkOverlap = dto.chunkOverlap ?? site.kbChunkOverlap;
    if (chunkOverlap >= chunkSize) {
      throw new BadRequestException(
        'Chunk overlap must be smaller than chunk size',
      );
    }

    Object.assign(site, {
      kbChunkSize: chunkSize,
      kbChunkOverlap: chunkOverlap,
      kbRetrievalTopK: dto.topKResults ?? site.kbRetrievalTopK,
      kbSimilarityThreshold:
        dto.similarityThreshold ?? site.kbSimilarityThreshold,
    });
    await this.siteRepository.save(site);
    return this.toKnowledgeBaseSettings(site);
  }

  async enqueueFileReindex(
    siteId: string,
    document: Document,
    user: JwtUser,
    site?: Site,
  ): Promise<{ documentId: string; status: DocumentReindexStatus }> {
    const resolvedSite =
      site ?? (await this.findOwnedSiteOrThrow(siteId, user));
    if (
      document.siteId !== siteId ||
      document.sourceKind !== DocumentSourceKind.FILE
    ) {
      throw new NotFoundException('File source not found');
    }
    if (document.status !== DocumentStatus.READY) {
      throw new ConflictException('Only ready documents can be re-indexed');
    }
    if (
      [DocumentReindexStatus.QUEUED, DocumentReindexStatus.PROCESSING].includes(
        document.reindexStatus,
      )
    ) {
      throw new ConflictException('Document re-index is already in progress');
    }
    if (!document.cloudinaryPublicId) {
      throw new ConflictException(
        'Original file is unavailable for re-indexing',
      );
    }

    await this.documentRepository.update(document.id, {
      reindexStatus: DocumentReindexStatus.QUEUED,
      reindexError: null,
    });
    try {
      await this.documentQueue.add(
        'reindex-document',
        {
          documentId: document.id,
          uploadedByUserId: user.id,
          siteId,
          chunkSize: resolvedSite.kbChunkSize,
          chunkOverlap: resolvedSite.kbChunkOverlap,
        } satisfies DocumentReindexJobData,
        {
          jobId: `reindex-${document.id}`,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (error) {
      await this.documentRepository.update(document.id, {
        reindexStatus: DocumentReindexStatus.FAILED,
        reindexError: 'Unable to queue document re-index',
      });
      throw error;
    }
    return { documentId: document.id, status: DocumentReindexStatus.QUEUED };
  }

  async findDocumentForReindex(
    siteId: string,
    documentId: string,
  ): Promise<Document> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId, siteId },
    });
    if (!document)
      throw new NotFoundException('Knowledge base source not found');
    return document;
  }

  async findOutdatedDocuments(site: Site): Promise<Document[]> {
    return this.documentRepository
      .createQueryBuilder('document')
      .where('document.siteId = :siteId', { siteId: site.id })
      .andWhere('document.status = :status', { status: DocumentStatus.READY })
      .andWhere('document.reindexStatus NOT IN (:...activeStatuses)', {
        activeStatuses: [
          DocumentReindexStatus.QUEUED,
          DocumentReindexStatus.PROCESSING,
        ],
      })
      .andWhere(
        '(document.indexedChunkSize IS NULL OR document.indexedChunkOverlap IS NULL OR document.indexedChunkSize != :chunkSize OR document.indexedChunkOverlap != :chunkOverlap)',
        { chunkSize: site.kbChunkSize, chunkOverlap: site.kbChunkOverlap },
      )
      .getMany();
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

    const canManage =
      user.role === UserRole.SUPER_ADMIN ||
      site.ownerId === user.id ||
      (user.role === UserRole.ADMIN &&
        !!user.organizationId &&
        site.organizationId === user.organizationId);
    if (!canManage) {
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
      filePath: string | null;
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

  async downloadCloudinaryAsset(publicId: string): Promise<Buffer> {
    const sourceUrl = cloudinary.url(publicId, {
      resource_type: 'raw',
      secure: true,
      sign_url: true,
    });
    const response = await axios.get<ArrayBuffer>(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 30_000,
      maxContentLength: DOCUMENT_MAX_FILE_SIZE,
      maxBodyLength: DOCUMENT_MAX_FILE_SIZE,
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length > DOCUMENT_MAX_FILE_SIZE) {
      throw new ConflictException(
        'Original file exceeds the re-index size limit',
      );
    }
    return buffer;
  }

  private needsReindex(document: Document, site: Site): boolean {
    return (
      document.status === DocumentStatus.READY &&
      (document.indexedChunkSize !== site.kbChunkSize ||
        document.indexedChunkOverlap !== site.kbChunkOverlap)
    );
  }

  private async toKnowledgeBaseSettings(site: Site) {
    const outdatedDocumentsCount = await this.documentRepository
      .createQueryBuilder('document')
      .where('document.siteId = :siteId', { siteId: site.id })
      .andWhere('document.status = :status', { status: DocumentStatus.READY })
      .andWhere(
        '(document.indexedChunkSize IS NULL OR document.indexedChunkOverlap IS NULL OR document.indexedChunkSize != :chunkSize OR document.indexedChunkOverlap != :chunkOverlap)',
        { chunkSize: site.kbChunkSize, chunkOverlap: site.kbChunkOverlap },
      )
      .getCount();

    return {
      chunkSize: site.kbChunkSize,
      chunkOverlap: site.kbChunkOverlap,
      topKResults: site.kbRetrievalTopK,
      similarityThreshold: site.kbSimilarityThreshold,
      outdatedDocumentsCount,
    };
  }
}
