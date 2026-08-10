jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => {},
}));

import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Queue } from 'bull';
import { DocumentService } from './document.service';
import { DocumentStatus } from './enums/document-status.enum';
import { DocumentFileType } from './enums/document-file-type.enum';
import { UserRole } from '../user/enums/user-role.enum';
import type { JwtUser } from '../auth/types/jwt-user.type';
import type { Document } from './entities/document.entity';
import type { DocumentChunk } from './entities/document-chunk.entity';
import type { Site } from '../site/entities/site.entity';
import type { DocumentProcessingJobData } from './types/document-processing-job.type';

describe('DocumentService - Chunks & Stats', () => {
  let service: DocumentService;
  let mockDocRepo: {
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockChunkRepo: {
    find: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let mockSiteRepo: {
    findOne: jest.Mock;
  };
  let mockQueue: {
    add: jest.Mock;
  };

  const mockUser: JwtUser = {
    id: 'user-uuid-1',
    email: 'admin@example.com',
    role: UserRole.ADMIN,
    organizationId: 'org-uuid-1',
  };

  const mockSiteId = 'site-uuid-1';
  const mockDocId = 'doc-uuid-1';

  beforeEach(() => {
    mockDocRepo = {
      findOne: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    mockChunkRepo = {
      find: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    mockSiteRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: mockSiteId,
        ownerId: mockUser.id,
      }),
    };

    mockQueue = {
      add: jest.fn(),
    };

    service = new DocumentService(
      mockDocRepo as unknown as Repository<Document>,
      mockChunkRepo as unknown as Repository<DocumentChunk>,
      mockSiteRepo as unknown as Repository<Site>,
      mockQueue as unknown as Queue<DocumentProcessingJobData>,
    );
  });

  describe('getDocumentChunks', () => {
    it('throws NotFoundException if document does not exist', async () => {
      mockDocRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getDocumentChunks(mockSiteId, mockDocId, mockUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns document detail and mapped chunks with vector metadata', async () => {
      const mockDocument = {
        id: mockDocId,
        filename: 'guide.pdf',
        fileType: DocumentFileType.PDF,
        fileSizeBytes: 10240,
        status: DocumentStatus.READY,
        filePath: 'https://cloudinary.com/guide.pdf',
        uploadedAt: new Date('2026-08-01'),
        processedAt: new Date('2026-08-01T00:01:00Z'),
      };

      const mockChunks = [
        {
          id: 'chunk-1',
          documentId: mockDocId,
          siteId: mockSiteId,
          chunkIndex: 0,
          content: 'First paragraph content',
          tokenCount: 45,
          sectionTitle: 'Introduction',
          metadata: { headingLevel: 1 },
          embeddingModel: 'text-embedding-3-small',
          createdAt: new Date('2026-08-01T00:01:00Z'),
        },
        {
          id: 'chunk-2',
          documentId: mockDocId,
          siteId: mockSiteId,
          chunkIndex: 1,
          content: 'Second paragraph content',
          tokenCount: 60,
          sectionTitle: 'Details',
          metadata: { headingLevel: 2 },
          embeddingModel: 'text-embedding-3-small',
          createdAt: new Date('2026-08-01T00:01:00Z'),
        },
      ];

      mockDocRepo.findOne.mockResolvedValue(mockDocument);
      mockChunkRepo.find.mockResolvedValue(mockChunks);

      const result = await service.getDocumentChunks(
        mockSiteId,
        mockDocId,
        mockUser,
      );

      expect(result.document.filename).toBe('guide.pdf');
      expect(result.document.chunksCount).toBe(2);
      expect(result.chunks).toHaveLength(2);
      expect(result.chunks[0]).toMatchObject({
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'First paragraph content',
        tokenCount: 45,
        vectorDimensions: 1536,
      });
    });
  });

  describe('getSiteKBStats', () => {
    it('aggregates total documents, chunks, tokens, size and calculates usage', async () => {
      mockDocRepo.count.mockResolvedValue(5);
      mockChunkRepo.count.mockResolvedValue(120);

      const docQbMock = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          totalSize: '5242880',
          lastProcessedAt: '2026-08-03T10:00:00.000Z',
        }),
      };
      mockDocRepo.createQueryBuilder.mockReturnValue(docQbMock);

      const chunkQbMock = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({
          totalTokens: '34500',
        }),
      };
      mockChunkRepo.createQueryBuilder.mockReturnValue(chunkQbMock);

      const stats = await service.getSiteKBStats(mockSiteId, mockUser);

      expect(stats.totalDocuments).toBe(5);
      expect(stats.totalChunks).toBe(120);
      expect(stats.totalSizeBytes).toBe(5242880);
      expect(stats.totalTokens).toBe(34500);
      expect(stats.vectorsUsed).toBe(120);
      expect(stats.vectorsLimit).toBe(100000);
      expect(stats.usagePercentage).toBe(0.12); // (120 / 100000) * 100 = 0.12%
    });
  });
});
