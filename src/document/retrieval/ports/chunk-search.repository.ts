import type { KnowledgeSearchResult } from '../types/knowledge-search.type';

export type ChunkSearchInput = {
  siteId: string;
  queryVector: number[];
  embeddingModel: string;
  topK: number;
};

export interface ChunkSearchRepository {
  searchSimilarChunks(
    input: ChunkSearchInput,
  ): Promise<KnowledgeSearchResult[]>;
}
