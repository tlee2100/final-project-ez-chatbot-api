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

@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,

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
}
