import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Document } from './document.entity';

@Entity('document_chunks')
@Index('IDX_document_chunks_documentId', ['documentId'])
@Index('IDX_document_chunks_siteId', ['siteId'])
@Index(
  'UQ_document_chunks_document_chunk_index',
  ['documentId', 'chunkIndex'],
  {
    unique: true,
  },
)
export class DocumentChunk {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  documentId: string;

  @ManyToOne(() => Document, (document) => document.chunks, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'documentId' })
  document: Document;

  @Column({ type: 'uuid' })
  siteId: string;

  @Column({ type: 'integer' })
  chunkIndex: number;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'integer' })
  tokenCount: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  sectionTitle: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Record<string, unknown>;

  @Column('vector', { length: 1536 })
  embedding: number[];

  @Column({ type: 'varchar', length: 100 })
  embeddingModel: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
