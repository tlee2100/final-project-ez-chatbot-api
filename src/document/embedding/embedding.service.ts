import { Inject, Injectable, Optional } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from 'openai/resources/embeddings';
import {
  type EmbeddingConfig,
  loadEmbeddingConfig,
} from '../config/embedding.config';
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MAX_ATTEMPTS,
  EMBEDDING_RETRY_BASE_DELAY_MS,
} from '../constants/document-embedding.constants';
import {
  EMBEDDING_CLIENT,
  EMBEDDING_CONFIG,
  EMBEDDING_DELAY,
} from '../constants/document.tokens';

export type EmbeddingClient = {
  embeddings: {
    create(params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse>;
  };
};
type Delay = (milliseconds: number) => Promise<void>;

export type EmbeddingResult = {
  vectors: number[][];
  model: string;
  dimensions: number;
};

export type SingleEmbeddingResult = {
  vector: number[];
  model: string;
  dimensions: number;
};

@Injectable()
export class EmbeddingService {
  private readonly client: EmbeddingClient;
  private readonly config: EmbeddingConfig;

  constructor(
    @Optional() @Inject(EMBEDDING_CLIENT) client?: EmbeddingClient,
    @Optional() @Inject(EMBEDDING_CONFIG) config?: EmbeddingConfig,
    @Optional()
    @Inject(EMBEDDING_DELAY)
    private readonly delay: Delay = defaultDelay,
  ) {
    this.config = config ?? loadEmbeddingConfig();
    this.client = client ?? new OpenAI({ apiKey: this.config.apiKey });
  }

  async embedMany(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return {
        vectors: [],
        model: this.config.model,
        dimensions: this.config.dimensions,
      };
    }

    if (texts.some((text) => !text.trim())) {
      throw new Error('Embedding input cannot contain empty text');
    }

    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
      vectors.push(...(await this.embedBatch(batch)));
    }

    return {
      vectors,
      model: this.config.model,
      dimensions: this.config.dimensions,
    };
  }

  async embedOne(text: string): Promise<SingleEmbeddingResult> {
    const result = await this.embedMany([text]);
    const vector = result.vectors[0];

    if (!vector) {
      throw new Error('Embedding response did not return a vector');
    }

    return {
      vector,
      model: result.model,
      dimensions: result.dimensions,
    };
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    for (let attempt = 1; attempt <= EMBEDDING_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.client.embeddings.create({
          input: texts,
          model: this.config.model,
          dimensions: this.config.dimensions,
          encoding_format: 'float',
        });

        return this.validateResponse(response, texts.length);
      } catch (error) {
        const hasMoreAttempts = attempt < EMBEDDING_MAX_ATTEMPTS;
        if (!hasMoreAttempts || !isRetriableError(error)) {
          throw error;
        }

        await this.delay(EMBEDDING_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }

    throw new Error('Embedding request exhausted all retry attempts');
  }

  private validateResponse(
    response: CreateEmbeddingResponse,
    expectedVectorCount: number,
  ): number[][] {
    if (response.data.length !== expectedVectorCount) {
      throw new Error(
        `Embedding response returned ${response.data.length} vectors for ${expectedVectorCount} inputs`,
      );
    }

    const ordered = [...response.data].sort(
      (left, right) => left.index - right.index,
    );

    return ordered.map((item, index) => {
      if (item.index !== index) {
        throw new Error('Embedding response indices do not match input order');
      }

      if (item.embedding.length !== this.config.dimensions) {
        throw new Error(
          `Embedding vector dimension ${item.embedding.length} does not match expected ${this.config.dimensions}`,
        );
      }

      if (!item.embedding.every(Number.isFinite)) {
        throw new Error('Embedding vector contains a non-finite value');
      }

      return [...item.embedding];
    });
  }
}

export function isRetriableError(error: unknown): boolean {
  const status = getErrorStatus(error);
  if (
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCode(error);
  return (
    /(?:APIConnection|APIConnectionTimeout|Abort|Fetch|Network)/i.test(
      error.name,
    ) || /^(?:E?CONN|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)/.test(code)
  );
}

function getErrorStatus(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
  ) {
    return error.status;
  }

  return undefined;
}

function getErrorCode(error: Error): string {
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }

  return '';
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type { EmbeddingCreateParams };
