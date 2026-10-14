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
import { CrawlerConfig } from './crawler-config.entity';
import { CrawlRunItem } from './crawl-run-item.entity';
import { CrawlRunStatus, CrawlRunTrigger } from '../enums/crawler.enums';

@Entity('crawl_runs')
@Index('IDX_crawl_runs_siteId_createdAt', ['siteId', 'createdAt'])
@Index('IDX_crawl_runs_siteId_status', ['siteId', 'status'])
export class CrawlRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @Column({ type: 'uuid', nullable: true })
  crawlerConfigId: string | null;

  @ManyToOne(() => CrawlerConfig, (config) => config.runs, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'crawlerConfigId' })
  crawlerConfig: CrawlerConfig | null;

  @Column({ type: 'uuid', nullable: true })
  requestedByUserId: string | null;

  @Column({ type: 'enum', enum: CrawlRunTrigger })
  trigger: CrawlRunTrigger;

  @Column({
    type: 'enum',
    enum: CrawlRunStatus,
    default: CrawlRunStatus.QUEUED,
  })
  status: CrawlRunStatus;

  @Column({ type: 'text' })
  targetUrl: string;

  @Column({ type: 'integer', default: 0 })
  totalPages: number;

  @Column({ type: 'integer', default: 0 })
  processedPages: number;

  @Column({ type: 'integer', default: 0 })
  indexedPages: number;

  @Column({ type: 'integer', default: 0 })
  unchangedPages: number;

  @Column({ type: 'integer', default: 0 })
  skippedPages: number;

  @Column({ type: 'integer', default: 0 })
  failedPages: number;

  @Column({ type: 'integer', default: 0 })
  quotaExceededPages: number;

  @Column({ type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  @OneToMany(() => CrawlRunItem, (item) => item.run)
  items: CrawlRunItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
