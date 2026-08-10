import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { CHUNK_SEARCH_REPOSITORY } from '../constants/document.tokens';
import { EmbeddingService } from '../embedding/embedding.service';
import type { ChunkSearchRepository } from './ports/chunk-search.repository';
import type {
  KnowledgeSearchResult,
  SearchRelevantChunksInput,
} from './types/knowledge-search.type';
import { validateSearchRelevantChunksInput } from './validation/knowledge-search-input.validator';

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    @Inject(CHUNK_SEARCH_REPOSITORY)
    private readonly chunkSearchRepository: ChunkSearchRepository,
  ) {}

  async searchRelevantChunks(
    input: SearchRelevantChunksInput,
  ): Promise<KnowledgeSearchResult[]> {
    const { siteId, query, topK, minSimilarity } =
      validateSearchRelevantChunksInput(input);

    const totalStartedAt = performance.now();
    const embedding = await this.embeddingService.embedOne(query);
    const embeddingCompletedAt = performance.now();

    const candidates = await this.chunkSearchRepository.searchSimilarChunks({
      siteId,
      queryVector: embedding.vector,
      embeddingModel: embedding.model,
      topK,
    });
    const searchCompletedAt = performance.now();

    const results = candidates.filter(
      (result) => result.similarity >= minSimilarity,
    );

    this.logger.debug({
      event: 'knowledge_retrieval_completed',
      siteId,
      topK,
      minSimilarity,
      embeddingDurationMs: embeddingCompletedAt - totalStartedAt,
      vectorSearchDurationMs: searchCompletedAt - embeddingCompletedAt,
      totalDurationMs: searchCompletedAt - totalStartedAt,
      candidateCount: candidates.length,
      acceptedCount: results.length,
    });

    return results;
  }
}
