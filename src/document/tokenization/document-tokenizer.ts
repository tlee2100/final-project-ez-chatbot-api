import { encodingForModel, type Tiktoken } from 'js-tiktoken';
import { DEFAULT_EMBEDDING_MODEL } from '../constants/document-embedding.constants';

export class DocumentTokenizer {
  private readonly encoder: Tiktoken = encodingForModel(
    DEFAULT_EMBEDDING_MODEL,
  );

  countTokens(text: string): number {
    return text ? this.encoder.encode(text).length : 0;
  }

  truncateToTokens(text: string, maxTokens: number): string {
    this.assertPositiveLimit(maxTokens);

    const tokens = this.encoder.encode(text);
    if (tokens.length <= maxTokens) {
      return text;
    }

    return this.decodeSafely(tokens.slice(0, maxTokens));
  }

  lastTokens(text: string, maxTokens: number): string {
    this.assertPositiveLimit(maxTokens);

    const tokens = this.encoder.encode(text);
    return this.decodeSafely(tokens.slice(-maxTokens));
  }

  tokensFor(text: string): number[] {
    return this.encoder.encode(text);
  }

  decodeTokens(tokens: number[]): string {
    return this.decodeSafely(tokens);
  }

  private decodeSafely(tokens: number[]): string {
    let start = 0;
    let end = tokens.length;

    while (start < end) {
      const decoded = this.encoder.decode(tokens.slice(start, end));
      if (!decoded.includes('\uFFFD')) {
        return decoded;
      }

      if (decoded.startsWith('\uFFFD')) {
        start += 1;
      } else {
        end -= 1;
      }
    }

    return '';
  }

  private assertPositiveLimit(maxTokens: number): void {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error('Token limit must be a positive integer');
    }
  }
}
