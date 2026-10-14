import { DocumentTokenizer } from './document-tokenizer';

describe('DocumentTokenizer', () => {
  const tokenizer = new DocumentTokenizer();

  it('counts English text and empty content consistently', () => {
    expect(tokenizer.countTokens('')).toBe(0);
    expect(tokenizer.countTokens('Knowledge base content')).toBeGreaterThan(0);
    expect(tokenizer.countTokens('Knowledge base content')).toBe(
      tokenizer.countTokens('Knowledge base content'),
    );
  });

  it('truncates text to the requested token limit', () => {
    const text = 'One two three four five six seven eight nine ten';
    const truncated = tokenizer.truncateToTokens(text, 4);

    expect(tokenizer.countTokens(truncated)).toBeLessThanOrEqual(4);
    expect(truncated).not.toContain('\uFFFD');
  });

  it('preserves Unicode text without decoding replacement characters', () => {
    const vietnamese = 'Đây là nội dung tiếng Việt có dấu. '.repeat(40);
    const truncated = tokenizer.truncateToTokens(vietnamese, 30);

    expect(tokenizer.countTokens(truncated)).toBeLessThanOrEqual(30);
    expect(truncated).not.toContain('\uFFFD');
    expect(tokenizer.lastTokens(vietnamese, 30)).not.toContain('\uFFFD');
  });

  it('returns the original text when it already fits', () => {
    const text = 'Nội dung ngắn';

    expect(tokenizer.truncateToTokens(text, 100)).toBe(text);
  });

  it.each([0, -1, 1.5])('rejects an invalid token limit: %s', (limit) => {
    expect(() => tokenizer.truncateToTokens('text', limit)).toThrow(
      'Token limit must be a positive integer',
    );
  });
});
