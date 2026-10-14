import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { CrawlRun } from './crawl-run.entity';

@Entity('crawler_configs')
@Index('UQ_crawler_configs_siteId', ['siteId'], { unique: true })
export class CrawlerConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @Column({ type: 'text' })
  sitemapUrl: string;

  @Column({ type: 'boolean', default: false })
  autoSyncEnabled: boolean;

  @Column({ type: 'integer', default: 7 })
  intervalDays: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt: Date | null;

  @OneToMany(() => CrawlRun, (run) => run.crawlerConfig)
  runs: CrawlRun[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
