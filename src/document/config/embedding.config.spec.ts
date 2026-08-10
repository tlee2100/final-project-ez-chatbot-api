import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
} from '../constants/document-embedding.constants';
import { loadEmbeddingConfig } from './embedding.config';

describe('loadEmbeddingConfig', () => {
  it('uses safe defaults when optional embedding settings are omitted', () => {
    const config = loadEmbeddingConfig({
      OPENAI_API_KEY: 'test-key',
    });

    expect(config).toEqual({
      apiKey: 'test-key',
      model: DEFAULT_EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
    });
  });

  it('accepts a configured model and the schema dimension', () => {
    const config = loadEmbeddingConfig({
      OPENAI_API_KEY: ' test-key ',
      OPENAI_EMBEDDING_MODEL: ' custom-embedding-model ',
      OPENAI_EMBEDDING_DIMENSIONS: '1536',
    });

    expect(config).toEqual({
      apiKey: 'test-key',
      model: 'custom-embedding-model',
      dimensions: 1536,
    });
  });

  it('rejects a missing API key without exposing a secret', () => {
    expect(() => loadEmbeddingConfig({})).toThrow('OPENAI_API_KEY is required');
  });

  it.each(['0', '-1', '1.5', 'invalid'])(
    'rejects invalid dimensions: %s',
    (dimensions) => {
      expect(() =>
        loadEmbeddingConfig({
          OPENAI_API_KEY: 'test-key',
          OPENAI_EMBEDDING_DIMENSIONS: dimensions,
        }),
      ).toThrow('must be a positive integer');
    },
  );

  it('rejects dimensions that do not match the PgVector schema', () => {
    expect(() =>
      loadEmbeddingConfig({
        OPENAI_API_KEY: 'test-key',
        OPENAI_EMBEDDING_DIMENSIONS: '3072',
      }),
    ).toThrow('must be 1536 to match the PgVector schema');
  });
});
