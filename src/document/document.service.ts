import {
  BadRequestException,
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
import { Document } from './entities/document.entity';
import { Site } from '../site/entities/site.entity';
import { DocumentStatus } from './enums/document-status.enum';
import type { DocumentProcessingJobData } from './types/document-processing-job.type';
import type { JwtUser } from 'src/auth/types/jwt-user.type';

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

  async uploadDocument(
    siteId: string,
    file: Express.Multer.File,
    uploadedByUser: JwtUser,
  ) {
    await this.findOwnedSiteOrThrow(siteId, uploadedByUser);

    if (!file.buffer) {
      throw new BadRequestException('File buffer is required');
    }

    const uploadedFile = await this.uploadToCloudinary(file);

    let savedDocument: Document;

    try {
      const document = this.documentRepository.create({
        filename: file.originalname,
        filePath: uploadedFile.secure_url,
        cloudinaryPublicId: uploadedFile.public_id,
        status: DocumentStatus.PENDING,
        siteId,
      });

      savedDocument = await this.documentRepository.save(document);
    } catch (error) {
      await this.deleteCloudinaryAsset(uploadedFile.public_id);
      this.logger.error(
        'Failed to save uploaded document metadata',
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException(
        'Failed to save uploaded document metadata',
      );
    }

    const jobData: DocumentProcessingJobData = {
      documentId: savedDocument.id,
      filePath: savedDocument.filePath,
      uploadedByUserId: uploadedByUser.id,
    };

    try {
      await this.documentQueue.add('process-document', jobData, {
        jobId: savedDocument.id,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });
    } catch (error) {
      await this.deleteCloudinaryAsset(savedDocument.cloudinaryPublicId);
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

  private async findOwnedSiteOrThrow(
    siteId: string,
    user: JwtUser,
  ): Promise<Site> {
    const site = await this.siteRepository.findOne({
      where: { id: siteId },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    if (site.ownerId !== user.id) {
      throw new ForbiddenException(
        'You do not have permission to upload documents to this site',
      );
    }

    return site;
  }

  private async deleteCloudinaryAsset(publicId: string | null): Promise<void> {
    if (!publicId) {
      return;
    }

    try {
      await cloudinary.uploader.destroy(publicId, {
        resource_type: 'raw',
      });
    } catch (error) {
      this.logger.error(
        `Failed to delete Cloudinary asset ${publicId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private uploadToCloudinary(
    file: Express.Multer.File,
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
          folder: 'documents',
          public_id: `${Date.now()}-${file.originalname}`,
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

      uploadStream.end(file.buffer);
    });
  }
}
