import { isUUID } from 'class-validator';
import {
  DEFAULT_RETRIEVAL_MIN_SIMILARITY,
  DEFAULT_RETRIEVAL_TOP_K,
  MAX_RETRIEVAL_TOP_K,
} from '../../constants/document-retrieval.constants';
import { InvalidSearchInputError } from '../errors/invalid-search-input.error';
import type {
  SearchRelevantChunksInput,
  ValidatedSearchInput,
} from '../types/knowledge-search.type';

export function validateSearchRelevantChunksInput(
  input: SearchRelevantChunksInput,
): ValidatedSearchInput {
  if (!input || typeof input.siteId !== 'string' || !isUUID(input.siteId)) {
    throw new InvalidSearchInputError(
      'INVALID_SITE_ID',
      'siteId must be a valid UUID',
    );
  }

  if (typeof input.query !== 'string' || !input.query.trim()) {
    throw new InvalidSearchInputError(
      'EMPTY_QUERY',
      'Retrieval query cannot be empty',
    );
  }

  const topK = input.topK ?? DEFAULT_RETRIEVAL_TOP_K;
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_RETRIEVAL_TOP_K) {
    throw new InvalidSearchInputError(
      'INVALID_TOP_K',
      `topK must be an integer between 1 and ${MAX_RETRIEVAL_TOP_K}`,
    );
  }

  const minSimilarity = input.minSimilarity ?? DEFAULT_RETRIEVAL_MIN_SIMILARITY;
  if (
    !Number.isFinite(minSimilarity) ||
    minSimilarity < 0 ||
    minSimilarity > 1
  ) {
    throw new InvalidSearchInputError(
      'INVALID_MIN_SIMILARITY',
      'minSimilarity must be a finite number between 0 and 1',
    );
  }

  return {
    siteId: input.siteId,
    query: input.query.trim(),
    topK,
    minSimilarity,
  };
}
