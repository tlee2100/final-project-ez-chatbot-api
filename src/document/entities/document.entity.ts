import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { DocumentStatus } from '../enums/document-status.enum';
import { DocumentFileType } from '../enums/document-file-type.enum';
import { DocumentChunk } from './document-chunk.entity';
import { DocumentSourceKind } from '../../crawler/enums/crawler.enums';
import { CrawlerConfig } from '../../crawler/entities/crawler-config.entity';
import { DocumentReindexStatus } from '../enums/document-reindex-status.enum';

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  filename: string;

  @Column({ type: 'varchar', nullable: true })
  filePath: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentSourceKind,
    default: DocumentSourceKind.FILE,
  })
  sourceKind: DocumentSourceKind;

  @Column({ type: 'text', nullable: true })
  sourceUrl: string | null;

  @Column({ type: 'text', nullable: true })
  normalizedUrl: string | null;

  @Column({ type: 'text', nullable: true })
  canonicalUrl: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  contentHash: string | null;

  @Column({ type: 'text', nullable: true })
  etag: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastModified: Date | null;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'uuid', nullable: true })
  crawlerConfigId: string | null;

  @ManyToOne(() => CrawlerConfig, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'crawlerConfigId' })
  crawlerConfig: CrawlerConfig | null;

  @Column({ type: 'integer', default: 0 })
  consecutiveMissingRuns: number;

  @Index()
  @Column({
    type: 'enum',
    enum: DocumentFileType,
    default: DocumentFileType.TXT,
  })
  fileType: DocumentFileType;

  @Column({ type: 'integer', nullable: true })
  fileSizeBytes: number | null;

  @Column({ type: 'varchar', nullable: true })
  cloudinaryPublicId: string | null;

  @Column({
    type: 'enum',
    enum: DocumentStatus,
    default: DocumentStatus.PENDING,
  })
  status: DocumentStatus;

  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, (site) => site.documents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @OneToMany(() => DocumentChunk, (chunk) => chunk.document)
  chunks: DocumentChunk[];

  @CreateDateColumn()
  uploadedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'integer', nullable: true })
  indexedChunkSize: number | null;

  @Column({ type: 'integer', nullable: true })
  indexedChunkOverlap: number | null;

  @Column({
    type: 'enum',
    enum: DocumentReindexStatus,
    default: DocumentReindexStatus.IDLE,
  })
  reindexStatus: DocumentReindexStatus;

  @Column({ type: 'text', nullable: true })
  reindexError: string | null;
}
