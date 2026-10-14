import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from '../constants/document-embedding.constants';

export {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from '../constants/document-embedding.constants';

export type EmbeddingConfig = {
  apiKey: string;
  model: string;
  dimensions: number;
};

export function loadEmbeddingConfig(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'OpenAI embedding configuration is invalid: OPENAI_API_KEY is required',
    );
  }

  const model = env.OPENAI_EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
  const rawDimensions =
    env.OPENAI_EMBEDDING_DIMENSIONS?.trim() || String(EMBEDDING_DIMENSIONS);
  const dimensions = Number(rawDimensions);

  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      'OpenAI embedding configuration is invalid: OPENAI_EMBEDDING_DIMENSIONS must be a positive integer',
    );
  }

  if (dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `OpenAI embedding configuration is invalid: OPENAI_EMBEDDING_DIMENSIONS must be ${EMBEDDING_DIMENSIONS} to match the PgVector schema`,
    );
  }

  return {
    apiKey,
    model,
    dimensions,
  };
}
