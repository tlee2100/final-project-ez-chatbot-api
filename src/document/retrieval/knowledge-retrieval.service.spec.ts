import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CHUNK_SEARCH_REPOSITORY } from '../constants/document.tokens';
import { EmbeddingService } from '../embedding/embedding.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';
import type { KnowledgeSearchResult } from './types/knowledge-search.type';
import { Site } from '../../site/entities/site.entity';

jest.mock('@automapper/classes', () => ({ AutoMap: () => () => undefined }));

describe('KnowledgeRetrievalService', () => {
  const siteId = '1b0d9f14-2cb6-4ca6-9eb1-54c29a1d03d6';
  const vector = [0.1, 0.2, 0.3];
  const model = 'text-embedding-3-small';
  let embedOne: jest.Mock;
  let searchSimilarChunks: jest.Mock;
  let debugLog: jest.SpyInstance;
  let service: KnowledgeRetrievalService;

  beforeEach(async () => {
    embedOne = jest.fn().mockResolvedValue({
      vector,
      model,
      dimensions: vector.length,
    });
    searchSimilarChunks = jest.fn().mockResolvedValue([]);
    debugLog = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    const moduleRef = await Test.createTestingModule({
      providers: [
        KnowledgeRetrievalService,
        { provide: EmbeddingService, useValue: { embedOne } },
        {
          provide: CHUNK_SEARCH_REPOSITORY,
          useValue: { searchSimilarChunks },
        },
        {
          provide: getRepositoryToken(Site),
          useValue: {
            findOne: jest.fn().mockResolvedValue({
              id: siteId,
              kbRetrievalTopK: 4,
              kbSimilarityThreshold: 0.5,
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(KnowledgeRetrievalService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the search port and searches with normalized defaults', async () => {
    await service.searchRelevantChunks({
      siteId,
      query: '  return policy  ',
    });

    expect(embedOne).toHaveBeenCalledWith('return policy');
    expect(searchSimilarChunks).toHaveBeenCalledWith({
      siteId,
      queryVector: vector,
      embeddingModel: model,
      topK: 4,
    });
  });

  it('ignores caller topK and enforces the site setting', async () => {
    await service.searchRelevantChunks({ siteId, query: 'shipping', topK: 12 });

    expect(searchSimilarChunks).toHaveBeenCalledWith(
      expect.objectContaining({ topK: 4 }),
    );
  });

  it('ignores caller similarity threshold and enforces the site setting', async () => {
    const candidates = [
      result('first', 0.95),
      result('second', 0.8),
      result('third', 0.7),
    ];
    searchSimilarChunks.mockResolvedValue(candidates);

    await expect(
      service.searchRelevantChunks({
        siteId,
        query: 'refund',
        minSimilarity: 0.8,
      }),
    ).resolves.toEqual(candidates);
  });

  it('does not let callers lower the site similarity threshold', async () => {
    const candidates = [result('positive', 0.8), result('zero', 0)];
    searchSimilarChunks.mockResolvedValue(candidates);

    await expect(
      service.searchRelevantChunks({
        siteId,
        query: 'broad search',
        minSimilarity: 0,
      }),
    ).resolves.toEqual([candidates[0]]);
  });

  it('does not query the repository when query embedding fails', async () => {
    const error = new Error('embedding unavailable');
    embedOne.mockRejectedValue(error);

    await expect(
      service.searchRelevantChunks({ siteId, query: 'question' }),
    ).rejects.toBe(error);
    expect(searchSimilarChunks).not.toHaveBeenCalled();
    expect(debugLog).not.toHaveBeenCalled();
  });

  it('logs structured latency and result counts without sensitive payloads', async () => {
    searchSimilarChunks.mockResolvedValue([
      result('accepted', 0.9),
      result('rejected', 0.5),
    ]);

    await service.searchRelevantChunks({
      siteId,
      query: 'sensitive customer question',
    });

    expect(debugLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'knowledge_retrieval_completed',
        siteId,
        topK: 4,
        minSimilarity: 0.5,
        embeddingDurationMs: expect.any(Number) as number,
        vectorSearchDurationMs: expect.any(Number) as number,
        totalDurationMs: expect.any(Number) as number,
        candidateCount: 2,
        acceptedCount: 2,
      }),
    );

    const serializedLog = JSON.stringify(debugLog.mock.calls.at(-1));
    expect(serializedLog).not.toContain('sensitive customer question');
    expect(serializedLog).not.toContain(JSON.stringify(vector));
  });
});

function result(id: string, similarity: number): KnowledgeSearchResult {
  return {
    chunkId: id,
    documentId: `document-${id}`,
    filename: `${id}.txt`,
    content: `${id} content`,
    tokenCount: 10,
    sectionTitle: null,
    metadata: {},
    similarity,
  };
}
