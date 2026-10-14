import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentChunkingService } from '../../document/chunking/document-chunking.service';
import {
  DOCUMENT_CHUNK_INSERT_BATCH_SIZE,
  DOCUMENT_VECTOR_LIMIT,
} from '../../document/constants/document-storage.constants';
import { EmbeddingService } from '../../document/embedding/embedding.service';
import { DocumentChunk } from '../../document/entities/document-chunk.entity';
import { Document } from '../../document/entities/document.entity';
import { DocumentFileType } from '../../document/enums/document-file-type.enum';
import { DocumentStatus } from '../../document/enums/document-status.enum';
import { DocumentReindexStatus } from '../../document/enums/document-reindex-status.enum';
import { Site } from '../../site/entities/site.entity';
import { DocumentSourceKind } from '../enums/crawler.enums';
import { CrawlerQuotaExceededError } from '../errors/crawler.errors';

export type IndexWebPageInput = {
  siteId: string;
  crawlerConfigId: string | null;
  sourceUrl: string;
  normalizedUrl: string;
  canonicalUrl: string | null;
  title: string;
  content: string;
  contentHash: string;
  etag: string | null;
  lastModified: Date | null;
};

@Injectable()
export class CrawlerIndexingService {
  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    private readonly chunking: DocumentChunkingService,
    private readonly embedding: EmbeddingService,
  ) {}

  findExisting(
    siteId: string,
    normalizedUrl: string,
  ): Promise<Document | null> {
    return this.documentRepository.findOne({
      where: { siteId, normalizedUrl, sourceKind: DocumentSourceKind.URL },
    });
  }

  findExistingByCanonical(
    siteId: string,
    canonicalUrl: string,
  ): Promise<Document | null> {
    return this.documentRepository.findOne({
      where: { siteId, canonicalUrl, sourceKind: DocumentSourceKind.URL },
      order: { uploadedAt: 'ASC' },
    });
  }

  async markUnchanged(
    document: Document,
    input: Pick<
      IndexWebPageInput,
      'sourceUrl' | 'canonicalUrl' | 'etag' | 'lastModified'
    >,
  ): Promise<Document> {
    await this.documentRepository.update(document.id, {
      sourceUrl: input.sourceUrl,
      canonicalUrl: input.canonicalUrl,
      etag: input.etag,
      lastModified: input.lastModified,
      isActive: true,
      consecutiveMissingRuns: 0,
    });
    return { ...document, ...input, isActive: true, consecutiveMissingRuns: 0 };
  }

  async index(
    input: IndexWebPageInput,
    matchedDocument?: Document | null,
  ): Promise<Document> {
    const existing =
      matchedDocument ??
      (await this.findExisting(input.siteId, input.normalizedUrl));
    const isCanonicalAlias =
      !!existing && existing.normalizedUrl !== input.normalizedUrl;
    const site = await this.siteRepository.findOneByOrFail({
      id: input.siteId,
    });
    const chunks = this.chunking.chunk(input.content, DocumentFileType.URL, {
      chunkSize: site.kbChunkSize,
      chunkOverlap: site.kbChunkOverlap,
    });
    const [totalChunks, oldChunks] = await Promise.all([
      this.chunkRepository.count({ where: { siteId: input.siteId } }),
      existing
        ? this.chunkRepository.count({ where: { documentId: existing.id } })
        : Promise.resolve(0),
    ]);
    if (totalChunks - oldChunks + chunks.length > DOCUMENT_VECTOR_LIMIT) {
      throw new CrawlerQuotaExceededError();
    }
    const embeddingResult = await this.embedding.embedMany(
      chunks.map((chunk) => chunk.content),
    );
    const processedAt = new Date();

    return this.documentRepository.manager.transaction(async (manager) => {
      let document = existing
        ? await manager.findOneByOrFail(Document, { id: existing.id })
        : manager.create(Document, {
            siteId: input.siteId,
            sourceKind: DocumentSourceKind.URL,
            fileType: DocumentFileType.URL,
            filePath: null,
            cloudinaryPublicId: null,
            uploadedAt: processedAt,
          });
      Object.assign(document, {
        filename: input.title,
        fileSizeBytes: Buffer.byteLength(input.content, 'utf8'),
        sourceUrl: isCanonicalAlias ? existing?.sourceUrl : input.sourceUrl,
        normalizedUrl: isCanonicalAlias
          ? existing?.normalizedUrl
          : input.normalizedUrl,
        canonicalUrl: input.canonicalUrl,
        contentHash: input.contentHash,
        etag: input.etag,
        lastModified: input.lastModified,
        crawlerConfigId: existing?.crawlerConfigId ?? input.crawlerConfigId,
        consecutiveMissingRuns: 0,
        isActive: true,
        status: DocumentStatus.READY,
        processedAt,
        indexedChunkSize: site.kbChunkSize,
        indexedChunkOverlap: site.kbChunkOverlap,
        reindexStatus: DocumentReindexStatus.IDLE,
        reindexError: null,
      });
      document = await manager.save(Document, document);
      await manager.delete(DocumentChunk, { documentId: document.id });

      const rows = chunks.map((chunk, index) =>
        manager.create(DocumentChunk, {
          documentId: document.id,
          siteId: input.siteId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          sectionTitle: chunk.sectionTitle,
          metadata: {
            ...chunk.metadata,
            sourceKind: DocumentSourceKind.URL,
            sourceUrl: input.sourceUrl,
            canonicalUrl: input.canonicalUrl,
            title: input.title,
            crawledAt: processedAt.toISOString(),
          },
          embedding: embeddingResult.vectors[index],
          embeddingModel: embeddingResult.model,
        }),
      );
      for (
        let start = 0;
        start < rows.length;
        start += DOCUMENT_CHUNK_INSERT_BATCH_SIZE
      ) {
        await manager.save(
          DocumentChunk,
          rows.slice(start, start + DOCUMENT_CHUNK_INSERT_BATCH_SIZE),
        );
      }
      return document;
    });
  }
}
