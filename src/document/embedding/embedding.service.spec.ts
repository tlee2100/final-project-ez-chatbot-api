import type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from 'openai/resources/embeddings';
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_RETRY_BASE_DELAY_MS,
} from '../constants/document-embedding.constants';
import { EmbeddingService, type EmbeddingClient } from './embedding.service';

const dimensions = 1536;
const config = {
  apiKey: 'test-key',
  model: 'text-embedding-3-small',
  dimensions,
};

type CreateEmbedding = (
  params: EmbeddingCreateParams,
) => Promise<CreateEmbeddingResponse>;

describe('EmbeddingService', () => {
  it('embeds one input and returns a single vector with model metadata', async () => {
    const create = createMock().mockResolvedValue(responseFor(['question']));
    const service = createService(create);

    await expect(service.embedOne('question')).resolves.toEqual({
      vector: expect.any(Array) as number[],
      model: config.model,
      dimensions,
    });
    expect(create).toHaveBeenCalledWith({
      input: ['question'],
      model: config.model,
      dimensions,
      encoding_format: 'float',
    });
  });

  it('propagates provider errors when embedding one input', async () => {
    const providerError = Object.assign(new Error('invalid API key'), {
      status: 401,
    });
    const create = createMock().mockRejectedValue(providerError);
    const service = createService(create);

    await expect(service.embedOne('question')).rejects.toBe(providerError);
  });

  it('does not call OpenAI for an empty input', async () => {
    const create = createMock();
    const service = createService(create);

    await expect(service.embedMany([])).resolves.toEqual({
      vectors: [],
      model: config.model,
      dimensions,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('embeds a batch using the configured model and dimensions', async () => {
    const create = createMock().mockResolvedValue(
      responseFor(['first', 'second']),
    );
    const service = createService(create);

    const result = await service.embedMany(['first', 'second']);

    expect(create).toHaveBeenCalledWith({
      input: ['first', 'second'],
      model: config.model,
      dimensions,
      encoding_format: 'float',
    });
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0][0]).toBe(1);
    expect(result.vectors[1][0]).toBe(2);
  });

  it('splits more than 64 inputs into ordered batches', async () => {
    const inputs = Array.from(
      { length: EMBEDDING_BATCH_SIZE + 1 },
      (_, index) => `chunk-${index}`,
    );
    const create = createMock()
      .mockResolvedValueOnce(responseFor(inputs.slice(0, EMBEDDING_BATCH_SIZE)))
      .mockResolvedValueOnce(
        responseFor(inputs.slice(EMBEDDING_BATCH_SIZE), EMBEDDING_BATCH_SIZE),
      );
    const service = createService(create);

    const result = await service.embedMany(inputs);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].input).toEqual(
      inputs.slice(0, EMBEDDING_BATCH_SIZE),
    );
    expect(create.mock.calls[1][0].input).toEqual(
      inputs.slice(EMBEDDING_BATCH_SIZE),
    );
    expect(result.vectors).toHaveLength(inputs.length);
    expect(result.vectors.at(-1)?.[0]).toBe(inputs.length);
  });

  it('uses response indices to preserve input order', async () => {
    const response = responseFor(['first', 'second', 'third']);
    response.data.reverse();
    const create = createMock().mockResolvedValue(response);
    const service = createService(create);

    const result = await service.embedMany(['first', 'second', 'third']);

    expect(result.vectors.map((vector) => vector[0])).toEqual([1, 2, 3]);
  });

  it('retries rate-limit and network errors with exponential backoff', async () => {
    const rateLimitError = Object.assign(new Error('rate limited'), {
      status: 429,
    });
    const networkError = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET',
    });
    const create = createMock()
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(responseFor(['retry me']));
    const delays: number[] = [];
    const service = createService(create, (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    });

    const result = await service.embedMany(['retry me']);

    expect(result.vectors).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([
      EMBEDDING_RETRY_BASE_DELAY_MS,
      EMBEDDING_RETRY_BASE_DELAY_MS * 2,
    ]);
  });

  it('retries 5xx responses', async () => {
    const error = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = createMock()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(responseFor(['retry me']));
    const delays: number[] = [];
    const service = createService(create, (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    });

    await expect(service.embedMany(['retry me'])).resolves.toMatchObject({
      model: config.model,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([EMBEDDING_RETRY_BASE_DELAY_MS]);
  });

  it.each([400, 401])(
    'does not retry non-retriable HTTP %i errors',
    async (status) => {
      const error = Object.assign(new Error('client error'), { status });
      const create = createMock().mockRejectedValue(error);
      const service = createService(create);

      await expect(service.embedMany(['invalid input'])).rejects.toBe(error);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a response with a missing vector', async () => {
    const response = responseFor(['one']);
    response.data = [];

    await expectInvalidResponse(response);
  });

  it('rejects a response with wrong dimensions', async () => {
    const response = responseFor(['one']);
    response.data[0].embedding = [1, 2];

    await expectInvalidResponse(response);
  });

  it('rejects a response with a non-finite vector value', async () => {
    const response = responseFor(['one']);
    response.data[0].embedding[0] = Number.NaN;

    await expectInvalidResponse(response);
  });

  it('rejects empty strings before calling OpenAI', async () => {
    const create = createMock();
    const service = createService(create);

    await expect(service.embedMany(['  '])).rejects.toThrow(
      'Embedding input cannot contain empty text',
    );
    expect(create).not.toHaveBeenCalled();
  });
});

function createService(
  create: jest.MockedFunction<CreateEmbedding>,
  delay: (milliseconds: number) => Promise<void> = () => Promise.resolve(),
): EmbeddingService {
  const client: EmbeddingClient = {
    embeddings: {
      create,
    },
  };

  return new EmbeddingService(client, config, delay);
}

async function expectInvalidResponse(
  response: CreateEmbeddingResponse,
): Promise<void> {
  const create = createMock().mockResolvedValue(response);
  const service = createService(create);

  await expect(service.embedMany(['one'])).rejects.toThrow();
}

function createMock(): jest.MockedFunction<CreateEmbedding> {
  return jest.fn<Promise<CreateEmbeddingResponse>, [EmbeddingCreateParams]>();
}

function responseFor(
  inputs: string[],
  vectorOffset = 0,
): CreateEmbeddingResponse {
  return {
    object: 'list',
    model: config.model,
    usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
    data: inputs.map((_, index) => ({
      object: 'embedding',
      index,
      embedding: Array.from(
        { length: dimensions },
        () => vectorOffset + index + 1,
      ),
    })),
  };
}
