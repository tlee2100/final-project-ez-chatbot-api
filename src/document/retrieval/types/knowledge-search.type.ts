export type SearchRelevantChunksInput = {
  siteId: string;
  query: string;
  topK?: number;
  minSimilarity?: number;
};

export type ValidatedSearchInput = {
  siteId: string;
  query: string;
  topK: number;
  minSimilarity: number;
};

export type KnowledgeSearchResult = {
  chunkId: string;
  documentId: string;
  filename: string;
  sourceUrl?: string | null;
  content: string;
  tokenCount: number;
  sectionTitle: string | null;
  metadata: Record<string, unknown>;
  similarity: number;
};
