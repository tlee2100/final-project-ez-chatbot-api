import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Document } from '../../document/entities/document.entity';
import { CrawlRunItemStatus } from '../enums/crawler.enums';
import { CrawlRun } from './crawl-run.entity';

@Entity('crawl_run_items')
@Index('IDX_crawl_run_items_runId_status', ['runId', 'status'])
@Index('UQ_crawl_run_items_run_url', ['runId', 'normalizedUrl'], {
  unique: true,
})
export class CrawlRunItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  runId: string;

  @ManyToOne(() => CrawlRun, (run) => run.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'runId' })
  run: CrawlRun;

  @Column({ type: 'uuid', nullable: true })
  documentId: string | null;

  @ManyToOne(() => Document, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'documentId' })
  document: Document | null;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'text' })
  normalizedUrl: string;

  @Column({ type: 'text', nullable: true })
  canonicalUrl: string | null;

  @Column({ type: 'enum', enum: CrawlRunItemStatus })
  status: CrawlRunItemStatus;

  @Column({ type: 'integer', nullable: true })
  httpStatus: number | null;

  @Column({ type: 'text', nullable: true })
  etag: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastModified: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  errorCode: string | null;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sitemapLastModified: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
