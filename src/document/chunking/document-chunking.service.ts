import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { DocumentFileType } from '../enums/document-file-type.enum';
import { DocumentTokenizer } from '../tokenization/document-tokenizer';
import {
  DOCUMENT_CHUNK_MAX_TOKENS,
  DOCUMENT_CHUNK_OVERLAP_TOKENS,
} from '../constants/document-chunking.constants';
import { DOCUMENT_TOKENIZER } from '../constants/document.tokens';

export type ChunkDraft = {
  chunkIndex: number;
  content: string;
  tokenCount: number;
  sectionTitle: string | null;
  metadata: Record<string, unknown>;
};

export type DocumentChunkingOptions = {
  chunkSize: number;
  chunkOverlap: number;
};

type ContentSection = {
  content: string;
  sectionTitle: string | null;
};

@Injectable()
export class DocumentChunkingService {
  constructor(
    @Optional()
    @Inject(DOCUMENT_TOKENIZER)
    private readonly tokenizer = new DocumentTokenizer(),
  ) {}

  chunk(
    content: string,
    fileType: DocumentFileType,
    options: DocumentChunkingOptions = {
      chunkSize: DOCUMENT_CHUNK_MAX_TOKENS,
      chunkOverlap: DOCUMENT_CHUNK_OVERLAP_TOKENS,
    },
  ): ChunkDraft[] {
    this.validateOptions(options);
    const normalizedContent = this.normalizeContent(content, fileType);
    if (!normalizedContent) {
      throw new BadRequestException(
        'Document content is empty after normalization',
      );
    }

    const sections = this.toSections(normalizedContent, fileType);
    const chunks = sections.flatMap((section) =>
      this.chunkSection(section, options),
    );

    if (chunks.length === 0) {
      throw new BadRequestException(
        'Document content does not contain any useful text',
      );
    }

    return chunks.map((chunk, chunkIndex) => ({
      chunkIndex,
      content: chunk.content,
      tokenCount: this.tokenizer.countTokens(chunk.content),
      sectionTitle: chunk.sectionTitle,
      metadata: { fileType },
    }));
  }

  private normalizeContent(
    content: string,
    fileType: DocumentFileType,
  ): string {
    const source =
      fileType === DocumentFileType.HTML ? this.htmlToText(content) : content;

    return source
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n[\t ]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[\t ]{2,}/g, ' ')
      .trim();
  }

  private htmlToText(html: string): string {
    return html
      .replace(
        /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_match, _level: string, value: string) => `\n\n# ${value}\n\n`,
      )
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
      .replace(/<(p|div|blockquote|tr|br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|blockquote|tr|table|ul|ol)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");
  }

  private toSections(
    content: string,
    fileType: DocumentFileType,
  ): ContentSection[] {
    if (
      fileType !== DocumentFileType.MARKDOWN &&
      fileType !== DocumentFileType.HTML
    ) {
      return [{ content, sectionTitle: null }];
    }

    const sections: ContentSection[] = [];
    let sectionTitle: string | null = null;
    let sectionLines: string[] = [];

    const addSection = () => {
      const sectionContent = sectionLines.join('\n').trim();
      if (sectionContent) {
        sections.push({ content: sectionContent, sectionTitle });
      }
    };

    for (const line of content.split('\n')) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (heading) {
        addSection();
        sectionTitle = heading[2].trim();
        sectionLines = [line.trim()];
      } else {
        sectionLines.push(line);
      }
    }
    addSection();

    return sections;
  }

  private chunkSection(
    section: ContentSection,
    options: DocumentChunkingOptions,
  ): ContentSection[] {
    const tokens = this.tokenizer.tokensFor(section.content);
    const chunks: ContentSection[] = [];
    let start = 0;

    while (start < tokens.length) {
      const hardEnd = Math.min(start + options.chunkSize, tokens.length);
      const end = this.findPreferredEnd(
        tokens,
        start,
        hardEnd,
        options.chunkSize,
      );
      const content = this.tokenizer
        .decodeTokens(tokens.slice(start, end))
        .trim();

      if (content) {
        chunks.push({ content, sectionTitle: section.sectionTitle });
      }

      if (end >= tokens.length) {
        break;
      }

      start = Math.max(start + 1, end - options.chunkOverlap);
    }

    return chunks;
  }

  private findPreferredEnd(
    tokens: number[],
    start: number,
    hardEnd: number,
    chunkSize: number,
  ): number {
    if (hardEnd === tokens.length) {
      return hardEnd;
    }

    const window = this.tokenizer.decodeTokens(tokens.slice(start, hardEnd));
    const boundary = this.findLastBoundary(window);
    if (!boundary) {
      return hardEnd;
    }

    const boundaryTokenCount = this.tokenizer.countTokens(
      window.slice(0, boundary),
    );
    const minimumTokens = Math.min(100, chunkSize);

    if (boundaryTokenCount < minimumTokens) {
      return hardEnd;
    }

    return Math.min(start + boundaryTokenCount, hardEnd);
  }

  private findLastBoundary(text: string): number | undefined {
    const candidates = [
      text.lastIndexOf('\n\n'),
      text.lastIndexOf('\n'),
      ...[...text.matchAll(/[.!?](?=\s|$)/g)].map((match) => match.index + 1),
    ].filter((index) => index > 0);

    return candidates.length > 0 ? Math.max(...candidates) : undefined;
  }

  private validateOptions(options: DocumentChunkingOptions): void {
    if (!Number.isInteger(options.chunkSize) || options.chunkSize < 1) {
      throw new BadRequestException('chunkSize must be a positive integer');
    }
    if (
      !Number.isInteger(options.chunkOverlap) ||
      options.chunkOverlap < 0 ||
      options.chunkOverlap >= options.chunkSize
    ) {
      throw new BadRequestException(
        'chunkOverlap must be a non-negative integer smaller than chunkSize',
      );
    }
  }
}
