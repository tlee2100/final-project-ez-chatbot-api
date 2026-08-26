import { Inject, Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CHUNK_SEARCH_REPOSITORY } from '../constants/document.tokens';
import { MAX_RETRIEVAL_TOP_K } from '../constants/document-retrieval.constants';
import { EmbeddingService } from '../embedding/embedding.service';
import type { ChunkSearchRepository } from './ports/chunk-search.repository';
import type {
  KnowledgeSearchResult,
  SearchRelevantChunksInput,
} from './types/knowledge-search.type';
import { validateSearchRelevantChunksInput } from './validation/knowledge-search-input.validator';
import { Site } from '../../site/entities/site.entity';

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(
    private readonly embeddingService: EmbeddingService,
    @Inject(CHUNK_SEARCH_REPOSITORY)
    private readonly chunkSearchRepository: ChunkSearchRepository,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async searchRelevantChunks(
    input: SearchRelevantChunksInput,
  ): Promise<KnowledgeSearchResult[]> {
    const baseInput = validateSearchRelevantChunksInput({
      siteId: input.siteId,
      query: input.query,
    });
    const site = await this.siteRepository.findOne({
      where: { id: baseInput.siteId },
      select: {
        id: true,
        kbRetrievalTopK: true,
        kbSimilarityThreshold: true,
      },
    });
    const { siteId, query, topK, minSimilarity } =
      validateSearchRelevantChunksInput({
        siteId: baseInput.siteId,
        query: baseInput.query,
        topK: site?.kbRetrievalTopK,
        minSimilarity: site?.kbSimilarityThreshold,
      });

    const totalStartedAt = performance.now();
    const embedding = await this.embeddingService.embedOne(query);
    const embeddingCompletedAt = performance.now();

    // Fetch a wider vector pool before applying the keyword-aware rerank. This
    // gives exact product/framework names a chance to surface even when their
    // short query has a modest embedding score.
    const candidateLimit = Math.min(MAX_RETRIEVAL_TOP_K, topK * 3);
    const candidates = await this.chunkSearchRepository.searchSimilarChunks({
      siteId,
      queryVector: embedding.vector,
      embeddingModel: embedding.model,
      topK: candidateLimit,
    });
    const searchCompletedAt = performance.now();

    const keywords = extractMeaningfulKeywords(query);
    const rankedCandidates = candidates
      .map((candidate) => ({
        candidate,
        keywordMatched: hasKeywordMatch(candidate.content, keywords),
      }))
      .sort((left, right) => {
        if (left.keywordMatched !== right.keywordMatched) {
          return left.keywordMatched ? -1 : 1;
        }
        return right.candidate.similarity - left.candidate.similarity;
      });

    const results = rankedCandidates
      .filter(
        ({ candidate, keywordMatched }) =>
          candidate.similarity >= minSimilarity || keywordMatched,
      )
      .slice(0, topK)
      .map(({ candidate, keywordMatched }) => ({
        ...candidate,
        keywordMatched,
      }));

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
      candidateScores: candidates.map((candidate) => ({
        documentId: candidate.documentId,
        filename: candidate.filename,
        similarity: candidate.similarity.toFixed(3),
        keywordMatched: hasKeywordMatch(candidate.content, keywords),
        accepted:
          candidate.similarity >= minSimilarity ||
          hasKeywordMatch(candidate.content, keywords),
      })),
      acceptedChunks: results.map((r) => ({
        docId: r.documentId,
        similarity: r.similarity.toFixed(3),
        keywordMatched: r.keywordMatched ?? false,
        preview: r.content.substring(0, 50).replace(/\n/g, ' ') + '...',
      })),
    });

    return results;
  }
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'có',
  'của',
  'cho',
  'do',
  'gì',
  'how',
  'in',
  'is',
  'là',
  'một',
  'nào',
  'of',
  'on',
  'the',
  'thế',
  'về',
  'what',
  'with',
]);

export function extractMeaningfulKeywords(query: string): string[] {
  const tokens = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return Array.from(
    new Set(
      tokens.filter(
        (token) => token.length >= 3 && !SEARCH_STOP_WORDS.has(token),
      ),
    ),
  );
}

function hasKeywordMatch(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const normalizedContent = content.toLocaleLowerCase();
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`,
      'u',
    ).test(normalizedContent);
  });
}
