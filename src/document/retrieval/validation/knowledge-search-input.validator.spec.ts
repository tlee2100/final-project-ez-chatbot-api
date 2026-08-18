import { InvalidSearchInputError } from '../errors/invalid-search-input.error';
import type { SearchRelevantChunksInput } from '../types/knowledge-search.type';
import { validateSearchRelevantChunksInput } from './knowledge-search-input.validator';

describe('validateSearchRelevantChunksInput', () => {
  const siteId = '1b0d9f14-2cb6-4ca6-9eb1-54c29a1d03d6';

  it('normalizes the query and applies retrieval defaults', () => {
    expect(
      validateSearchRelevantChunksInput({
        siteId,
        query: '  return policy  ',
      }),
    ).toEqual({
      siteId,
      query: 'return policy',
      topK: 4,
      minSimilarity: 0.5,
    });
  });

  it.each([0, 0.85, 1])(
    'accepts custom similarity threshold %s',
    (minSimilarity) => {
      expect(
        validateSearchRelevantChunksInput({
          siteId,
          query: 'question',
          minSimilarity,
        }).minSimilarity,
      ).toBe(minSimilarity);
    },
  );

  it.each([
    {
      label: 'invalid siteId',
      input: { siteId: 'invalid', query: 'question' },
      code: 'INVALID_SITE_ID' as const,
    },
    {
      label: 'empty query',
      input: { siteId, query: '   ' },
      code: 'EMPTY_QUERY' as const,
    },
    {
      label: 'zero topK',
      input: { siteId, query: 'question', topK: 0 },
      code: 'INVALID_TOP_K' as const,
    },
    {
      label: 'fractional topK',
      input: { siteId, query: 'question', topK: 1.5 },
      code: 'INVALID_TOP_K' as const,
    },
    {
      label: 'topK above maximum',
      input: { siteId, query: 'question', topK: 21 },
      code: 'INVALID_TOP_K' as const,
    },
    {
      label: 'negative threshold',
      input: { siteId, query: 'question', minSimilarity: -0.1 },
      code: 'INVALID_MIN_SIMILARITY' as const,
    },
    {
      label: 'threshold above one',
      input: { siteId, query: 'question', minSimilarity: 1.1 },
      code: 'INVALID_MIN_SIMILARITY' as const,
    },
    {
      label: 'NaN threshold',
      input: { siteId, query: 'question', minSimilarity: Number.NaN },
      code: 'INVALID_MIN_SIMILARITY' as const,
    },
    {
      label: 'infinite threshold',
      input: {
        siteId,
        query: 'question',
        minSimilarity: Number.POSITIVE_INFINITY,
      },
      code: 'INVALID_MIN_SIMILARITY' as const,
    },
  ])('throws $code for $label', ({ input, code }) => {
    expectInvalidInput(input, code);
  });
});

function expectInvalidInput(
  input: SearchRelevantChunksInput,
  expectedCode: InvalidSearchInputError['code'],
): void {
  expect.assertions(2);

  try {
    validateSearchRelevantChunksInput(input);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidSearchInputError);
    expect((error as InvalidSearchInputError).code).toBe(expectedCode);
  }
}
