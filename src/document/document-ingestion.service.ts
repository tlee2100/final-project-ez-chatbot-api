import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type DeepPartial, Repository } from 'typeorm';
import type { ChunkDraft } from './chunking/document-chunking.service';
import type { EmbeddingResult } from './embedding/embedding.service';
import { DocumentChunk } from './entities/document-chunk.entity';
import { Document } from './entities/document.entity';
import { DocumentStatus } from './enums/document-status.enum';
import { DocumentReindexStatus } from './enums/document-reindex-status.enum';

import {
  DOCUMENT_CHUNK_INSERT_BATCH_SIZE,
  DOCUMENT_VECTOR_LIMIT,
} from './constants/document-storage.constants';

export type PersistProcessedDocumentInput = {
  documentId: string;
  chunks: ChunkDraft[];
  embeddingResult: EmbeddingResult;
  filePath: string;
  cloudinaryPublicId: string;
  processedAt: Date;
  chunkSize: number;
  chunkOverlap: number;
  replaceExisting?: boolean;
};

@Injectable()
export class DocumentIngestionService {
  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
  ) {}

  async persistProcessedDocument(
    input: PersistProcessedDocumentInput,
  ): Promise<void> {
    this.validateInput(input);

    await this.documentRepository.manager.transaction(async (manager) => {
      const document = await manager.findOne(Document, {
        where: { id: input.documentId },
      });

      if (!document) {
        throw new NotFoundException(
          `Document record not found for processing: ${input.documentId}`,
        );
      }

      const chunks: DeepPartial<DocumentChunk>[] = input.chunks.map(
        (chunk, index) => ({
          documentId: document.id,
          siteId: document.siteId,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          sectionTitle: chunk.sectionTitle,
          metadata: chunk.metadata,
          embedding: input.embeddingResult.vectors[index],
          embeddingModel: input.embeddingResult.model,
        }),
      );

      const chunkRepository = manager.getRepository(DocumentChunk);
      const [siteChunkCount, existingDocumentChunkCount] = await Promise.all([
        chunkRepository.count({ where: { siteId: document.siteId } }),
        chunkRepository.count({ where: { documentId: document.id } }),
      ]);
      if (
        siteChunkCount - existingDocumentChunkCount + chunks.length >
        DOCUMENT_VECTOR_LIMIT
      ) {
        throw new Error('Knowledge base vector quota has been reached');
      }
      if (input.replaceExisting) {
        await chunkRepository.delete({ documentId: document.id });
      }
      for (
        let start = 0;
        start < chunks.length;
        start += DOCUMENT_CHUNK_INSERT_BATCH_SIZE
      ) {
        await chunkRepository.save(
          chunks.slice(start, start + DOCUMENT_CHUNK_INSERT_BATCH_SIZE),
        );
      }

      await manager.getRepository(Document).update(document.id, {
        filePath: input.filePath,
        cloudinaryPublicId: input.cloudinaryPublicId,
        processedAt: input.processedAt,
        status: DocumentStatus.READY,
        indexedChunkSize: input.chunkSize,
        indexedChunkOverlap: input.chunkOverlap,
        reindexStatus: DocumentReindexStatus.IDLE,
        reindexError: null,
      });
    });
  }

  private validateInput(input: PersistProcessedDocumentInput): void {
    const { chunks, embeddingResult } = input;
    if (chunks.length === 0) {
      throw new Error('Cannot persist a document without chunks');
    }

    if (chunks.length !== embeddingResult.vectors.length) {
      throw new Error(
        `Chunk count ${chunks.length} does not match embedding count ${embeddingResult.vectors.length}`,
      );
    }

    for (const [index, chunk] of chunks.entries()) {
      if (chunk.chunkIndex !== index) {
        throw new Error('Document chunk indices must be contiguous from zero');
      }

      if (
        embeddingResult.vectors[index].length !== embeddingResult.dimensions
      ) {
        throw new Error(
          `Embedding vector at index ${index} does not match the configured dimension`,
        );
      }
    }
  }
}
