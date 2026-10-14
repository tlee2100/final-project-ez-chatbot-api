jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => {},
}));

import type { Repository } from 'typeorm';
import { DocumentChunk } from '../entities/document-chunk.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { PgVectorChunkSearchRepository } from './pgvector-chunk-search.repository';

describe('PgVectorChunkSearchRepository', () => {
  let queryBuilder: Record<string, jest.Mock>;
  let chunkRepository: { createQueryBuilder: jest.Mock };
  let repository: PgVectorChunkSearchRepository;

  beforeEach(() => {
    queryBuilder = {
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    chunkRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    repository = new PgVectorChunkSearchRepository(
      chunkRepository as unknown as Repository<DocumentChunk>,
    );
  });

  it('builds a tenant-safe READY-document cosine query', async () => {
    await repository.searchSimilarChunks({
      siteId: 'site-id',
      queryVector: [0.1, 0.2],
      embeddingModel: 'text-embedding-3-small',
      topK: 7,
    });

    expect(chunkRepository.createQueryBuilder).toHaveBeenCalledWith('chunk');
    expect(queryBuilder.innerJoin).toHaveBeenCalledWith(
      'chunk.document',
      'document',
    );
    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      '1 - (chunk.embedding <=> CAST(:queryVector AS vector))',
      'similarity',
    );
    expect(queryBuilder.where).toHaveBeenCalledWith('chunk.siteId = :siteId');
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'document.siteId = :siteId',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'document.status = :readyStatus',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'chunk.embeddingModel = :embeddingModel',
    );
    expect(queryBuilder.setParameters).toHaveBeenCalledWith({
      queryVector: '[0.1,0.2]',
      siteId: 'site-id',
      readyStatus: DocumentStatus.READY,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(queryBuilder.orderBy).toHaveBeenCalledWith(
      'chunk.embedding <=> CAST(:queryVector AS vector)',
      'ASC',
    );
    expect(queryBuilder.limit).toHaveBeenCalledWith(7);
  });

  it('maps raw rows to typed results without exposing embeddings', async () => {
    queryBuilder.getRawMany.mockResolvedValue([
      {
        chunkId: 'chunk-1',
        documentId: 'document-1',
        filename: 'faq.txt',
        content: 'Return policy',
        tokenCount: '42',
        sectionTitle: 'Returns',
        metadata: { fileType: 'txt' },
        similarity: '0.87',
        embedding: '[0.1,0.2]',
      },
    ]);

    const results = await repository.searchSimilarChunks({
      siteId: 'site-id',
      queryVector: [0.1, 0.2],
      embeddingModel: 'text-embedding-3-small',
      topK: 5,
    });

    expect(results).toEqual([
      {
        chunkId: 'chunk-1',
        documentId: 'document-1',
        filename: 'faq.txt',
        content: 'Return policy',
        tokenCount: 42,
        sectionTitle: 'Returns',
        metadata: { fileType: 'txt' },
        similarity: 0.87,
      },
    ]);
    expect(results[0]).not.toHaveProperty('embedding');
  });

  it.each([
    { queryVector: [] },
    { queryVector: [Number.NaN] },
    { queryVector: [Number.POSITIVE_INFINITY] },
  ])(
    'rejects an invalid query vector $queryVector before querying',
    async ({ queryVector }) => {
      await expect(
        repository.searchSimilarChunks({
          siteId: 'site-id',
          queryVector,
          embeddingModel: 'text-embedding-3-small',
          topK: 5,
        }),
      ).rejects.toThrow('Query embedding must be a non-empty finite vector');

      expect(chunkRepository.createQueryBuilder).not.toHaveBeenCalled();
    },
  );
});
