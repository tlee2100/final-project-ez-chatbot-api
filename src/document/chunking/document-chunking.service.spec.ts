import { BadRequestException } from '@nestjs/common';
import { DocumentFileType } from '../enums/document-file-type.enum';
import { DocumentTokenizer } from '../tokenization/document-tokenizer';
import {
  DOCUMENT_CHUNK_MAX_TOKENS,
  DOCUMENT_CHUNK_OVERLAP_TOKENS,
} from '../constants/document-chunking.constants';
import { DocumentChunkingService } from './document-chunking.service';

describe('DocumentChunkingService', () => {
  const tokenizer = new DocumentTokenizer();
  const service = new DocumentChunkingService(tokenizer);

  it('returns one normalized chunk for short plain text', () => {
    const chunks = service.chunk(
      '  Knowledge base\r\n\r\n  content.  ',
      DocumentFileType.TXT,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toBe('Knowledge base\n\ncontent.');
    expect(chunks[0].sectionTitle).toBeNull();
    expect(chunks[0].metadata).toEqual({ fileType: DocumentFileType.TXT });
  });

  it('creates deterministic chunks below the token limit for long content', () => {
    const content = Array.from(
      { length: 1_400 },
      (_, index) => `knowledge-${index}`,
    ).join(' ');

    const firstRun = service.chunk(content, DocumentFileType.TXT);
    const secondRun = service.chunk(content, DocumentFileType.TXT);

    expect(firstRun.length).toBeGreaterThan(1);
    expect(firstRun).toEqual(secondRun);
    expect(firstRun.map((chunk) => chunk.chunkIndex)).toEqual(
      firstRun.map((_, index) => index),
    );
    expect(
      firstRun.every((chunk) => chunk.tokenCount <= DOCUMENT_CHUNK_MAX_TOKENS),
    ).toBe(true);
  });

  it('keeps Vietnamese content valid when a paragraph exceeds the token limit', () => {
    const content = 'Đây là nội dung kiến thức quan trọng. '.repeat(1_000);
    const chunks = service.chunk(content, DocumentFileType.TXT);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => !chunk.content.includes('\uFFFD'))).toBe(
      true,
    );
    expect(
      chunks.every((chunk) => chunk.tokenCount <= DOCUMENT_CHUNK_MAX_TOKENS),
    ).toBe(true);
  });

  it('preserves Markdown heading boundaries and section metadata', () => {
    const chunks = service.chunk(
      '# Chính sách đổi trả\n\nKhách hàng có thể đổi trả trong 30 ngày.\n\n## Điều kiện\n\nSản phẩm phải còn nguyên tem.',
      DocumentFileType.MARKDOWN,
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].sectionTitle).toBe('Chính sách đổi trả');
    expect(chunks[0].content).toContain('# Chính sách đổi trả');
    expect(chunks[1].sectionTitle).toBe('Điều kiện');
    expect(chunks[1].content).toContain('## Điều kiện');
  });

  it('converts sanitized HTML into structured chunks', () => {
    const chunks = service.chunk(
      '<h1>Shipping</h1><p>Orders ship within two business days.</p><ul><li>Tracking included</li><li>International delivery available</li></ul>',
      DocumentFileType.HTML,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionTitle).toBe('Shipping');
    expect(chunks[0].content).toContain('# Shipping');
    expect(chunks[0].content).toContain('Tracking included');
    expect(chunks[0].content).toContain('International delivery available');
  });

  it('starts the next long chunk with the configured token overlap', () => {
    const content = Array.from(
      { length: 2_000 },
      (_, index) => `item-${index}`,
    ).join(' ');
    const chunks = service.chunk(content, DocumentFileType.TXT);
    const expectedOverlap = tokenizer
      .lastTokens(chunks[0].content, DOCUMENT_CHUNK_OVERLAP_TOKENS)
      .trim();

    expect(chunks[1].content.startsWith(expectedOverlap)).toBe(true);
  });

  it('rejects content that is empty after normalization', () => {
    expect(() => service.chunk(' \r\n\t ', DocumentFileType.TXT)).toThrow(
      BadRequestException,
    );
  });
});
