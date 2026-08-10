import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentChunk } from '../entities/document-chunk.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import type {
  ChunkSearchInput,
  ChunkSearchRepository,
} from './ports/chunk-search.repository';
import type { KnowledgeSearchResult } from './types/knowledge-search.type';

type RawKnowledgeSearchRow = {
  chunkId: string;
  documentId: string;
  filename: string;
  content: string;
  tokenCount: string | number;
  sectionTitle: string | null;
  metadata: Record<string, unknown>;
  similarity: string | number;
};

@Injectable()
export class PgVectorChunkSearchRepository implements ChunkSearchRepository {
  constructor(
    @InjectRepository(DocumentChunk)
    private readonly chunkRepository: Repository<DocumentChunk>,
  ) {}

  async searchSimilarChunks(
    input: ChunkSearchInput,
  ): Promise<KnowledgeSearchResult[]> {
    const queryVector = this.toPgVectorLiteral(input.queryVector);
    const distanceExpression =
      'chunk.embedding <=> CAST(:queryVector AS vector)';

    const rows = await this.chunkRepository
      .createQueryBuilder('chunk')
      .innerJoin('chunk.document', 'document')
      .select('chunk.id', 'chunkId')
      .addSelect('chunk.documentId', 'documentId')
      .addSelect('document.filename', 'filename')
      .addSelect('chunk.content', 'content')
      .addSelect('chunk.tokenCount', 'tokenCount')
      .addSelect('chunk.sectionTitle', 'sectionTitle')
      .addSelect('chunk.metadata', 'metadata')
      .addSelect(`1 - (${distanceExpression})`, 'similarity')
      .where('chunk.siteId = :siteId')
      .andWhere('document.siteId = :siteId')
      .andWhere('document.status = :readyStatus')
      .andWhere('chunk.embeddingModel = :embeddingModel')
      .setParameters({
        queryVector,
        siteId: input.siteId,
        readyStatus: DocumentStatus.READY,
        embeddingModel: input.embeddingModel,
      })
      .orderBy(distanceExpression, 'ASC')
      .limit(input.topK)
      .getRawMany<RawKnowledgeSearchRow>();

    return rows.map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      filename: row.filename,
      content: row.content,
      tokenCount: Number(row.tokenCount),
      sectionTitle: row.sectionTitle,
      metadata: row.metadata,
      similarity: Number(row.similarity),
    }));
  }

  private toPgVectorLiteral(vector: number[]): string {
    if (vector.length === 0 || !vector.every(Number.isFinite)) {
      throw new Error('Query embedding must be a non-empty finite vector');
    }

    return `[${vector.join(',')}]`;
  }
}
