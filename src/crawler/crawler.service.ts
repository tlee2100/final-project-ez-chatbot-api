import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bull';
import { In, QueryFailedError, Repository } from 'typeorm';
import type { JwtUser } from '../auth/types/jwt-user.type';
import { Document } from '../document/entities/document.entity';
import { DocumentService } from '../document/document.service';
import { DocumentReindexStatus } from '../document/enums/document-reindex-status.enum';
import { DocumentStatus } from '../document/enums/document-status.enum';
import { SiteService } from '../site/site.service';
import {
  CRAWLER_INTERVAL_DAYS,
  CRAWLER_INTERVAL_MS,
  CRAWLER_QUEUE,
  CRAWL_PAGE_JOB,
  CRAWL_SITEMAP_JOB,
  SCHEDULED_CRAWL_JOB,
} from './constants/crawler.constants';
import type {
  CrawlPageJobData,
  CrawlSitemapJobData,
  ScheduledCrawlJobData,
} from './types/crawler-job.type';
import { UpdateCrawlerConfigDto } from './dto/crawler.dto';
import { CrawlerConfig } from './entities/crawler-config.entity';
import { CrawlRunItem } from './entities/crawl-run-item.entity';
import { CrawlRun } from './entities/crawl-run.entity';
import {
  ACTIVE_CRAWL_RUN_STATUSES,
  CrawlRunItemStatus,
  CrawlRunStatus,
  CrawlRunTrigger,
  DocumentSourceKind,
} from './enums/crawler.enums';
import { CrawlerUrlService } from './services/crawler-url.service';

@Injectable()
export class CrawlerService implements OnModuleInit {
  constructor(
    @InjectRepository(CrawlerConfig)
    private readonly configRepository: Repository<CrawlerConfig>,
    @InjectRepository(CrawlRun)
    private readonly runRepository: Repository<CrawlRun>,
    @InjectRepository(CrawlRunItem)
    private readonly itemRepository: Repository<CrawlRunItem>,
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectQueue(CRAWLER_QUEUE)
    private readonly queue: Queue<
      CrawlSitemapJobData | CrawlPageJobData | ScheduledCrawlJobData
    >,
    @Inject(forwardRef(() => SiteService))
    private readonly siteService: SiteService,
    private readonly documentService: DocumentService,
    private readonly urlService: CrawlerUrlService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.isFeatureEnabled()) return;
    const configs = await this.configRepository.find({
      where: { autoSyncEnabled: true },
    });
    for (const config of configs) await this.syncRepeatableJob(config);
  }

  async getConfig(siteId: string, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    const [config, activeRun] = await Promise.all([
      this.configRepository.findOne({ where: { siteId } }),
      this.findActiveRun(siteId),
    ]);
    return { config, activeRun };
  }

  async updateConfig(
    siteId: string,
    dto: UpdateCrawlerConfigDto,
    user: JwtUser,
  ) {
    this.assertFeatureEnabled();
    await this.siteService.assertSiteAccess(siteId, user);
    const normalized = this.urlService.normalize(dto.sitemapUrl);
    await this.urlService.assertPublicUrl(normalized);
    let config = await this.configRepository.findOne({ where: { siteId } });
    config ??= this.configRepository.create({ siteId });
    Object.assign(config, {
      sitemapUrl: normalized,
      autoSyncEnabled: dto.autoSyncEnabled,
      intervalDays: CRAWLER_INTERVAL_DAYS,
      nextRunAt: dto.autoSyncEnabled
        ? new Date(Date.now() + CRAWLER_INTERVAL_MS)
        : null,
    });
    config = await this.configRepository.save(config);
    await this.syncRepeatableJob(config);
    return config;
  }

  async startSitemap(siteId: string, user: JwtUser) {
    this.assertFeatureEnabled();
    await this.siteService.assertSiteAccess(siteId, user);
    const config = await this.configRepository.findOne({ where: { siteId } });
    if (!config) throw new NotFoundException('Crawler configuration not found');
    await this.urlService.assertPublicUrl(config.sitemapUrl);
    const run = await this.createRun({
      siteId,
      crawlerConfigId: config.id,
      requestedByUserId: user.id,
      trigger: CrawlRunTrigger.MANUAL_SITEMAP,
      targetUrl: config.sitemapUrl,
    });
    await this.queue.add(
      CRAWL_SITEMAP_JOB,
      { runId: run.id },
      this.sitemapJobOptions(run.id),
    );
    return { runId: run.id, status: run.status };
  }

  async startManualUrl(
    siteId: string,
    rawUrl: string,
    user: JwtUser,
    trigger: CrawlRunTrigger = CrawlRunTrigger.MANUAL_URL,
  ) {
    this.assertFeatureEnabled();
    await this.siteService.assertSiteAccess(siteId, user);
    const normalizedUrl = this.urlService.normalize(rawUrl);
    await this.urlService.assertPublicUrl(normalizedUrl);
    const run = await this.createRun({
      siteId,
      crawlerConfigId: null,
      requestedByUserId: user.id,
      trigger,
      targetUrl: normalizedUrl,
    });
    const item = await this.itemRepository.save(
      this.itemRepository.create({
        runId: run.id,
        url: normalizedUrl,
        normalizedUrl,
        status: CrawlRunItemStatus.QUEUED,
      }),
    );
    await this.runRepository.update(run.id, {
      totalPages: 1,
      status: CrawlRunStatus.PROCESSING,
      startedAt: new Date(),
    });
    await this.enqueuePage(item.id);
    return { runId: run.id, status: CrawlRunStatus.PROCESSING };
  }

  async recrawlDocument(siteId: string, documentId: string, user: JwtUser) {
    const site = await this.siteService.assertSiteAccess(siteId, user);
    const document = await this.documentRepository.findOne({
      where: { id: documentId, siteId, sourceKind: DocumentSourceKind.URL },
    });
    if (!document?.sourceUrl)
      throw new NotFoundException('Web source not found');
    this.assertReindexable(document);
    await this.documentRepository.update(document.id, {
      reindexStatus: DocumentReindexStatus.QUEUED,
      reindexError: null,
    });
    let result: Awaited<ReturnType<CrawlerService['startManualUrl']>>;
    try {
      result = await this.startManualUrl(
        siteId,
        document.sourceUrl,
        user,
        CrawlRunTrigger.RECRAWL_PAGE,
      );
    } catch (error) {
      await this.documentRepository.update(document.id, {
        reindexStatus: DocumentReindexStatus.FAILED,
        reindexError: 'Unable to queue URL re-index',
      });
      throw error;
    }
    return {
      ...result,
      documentId: document.id,
      chunkSize: site.kbChunkSize,
      chunkOverlap: site.kbChunkOverlap,
    };
  }

  async reindexDocument(siteId: string, documentId: string, user: JwtUser) {
    const site = await this.siteService.assertSiteAccess(siteId, user);
    const document = await this.documentService.findDocumentForReindex(
      siteId,
      documentId,
    );
    this.assertReindexable(document);
    if (document.sourceKind === DocumentSourceKind.URL) {
      return this.recrawlDocument(siteId, documentId, user);
    }
    return this.documentService.enqueueFileReindex(
      siteId,
      document,
      user,
      site,
    );
  }

  async reindexOutdated(siteId: string, user: JwtUser) {
    const site = await this.siteService.assertSiteAccess(siteId, user);
    const outdated = await this.documentService.findOutdatedDocuments(site);
    const urlDocuments = outdated.filter(
      (document) => document.sourceKind === DocumentSourceKind.URL,
    );
    const fileDocuments = outdated.filter(
      (document) => document.sourceKind === DocumentSourceKind.FILE,
    );
    let queued = 0;

    if (urlDocuments.length > 0) {
      const run = await this.createRun({
        siteId,
        crawlerConfigId: null,
        requestedByUserId: user.id,
        trigger: CrawlRunTrigger.RECRAWL_PAGE,
        targetUrl: urlDocuments[0].sourceUrl ?? 'bulk-reindex',
      });
      const items = await this.itemRepository.save(
        urlDocuments.map((document) =>
          this.itemRepository.create({
            runId: run.id,
            url: document.sourceUrl!,
            normalizedUrl: document.normalizedUrl!,
            status: CrawlRunItemStatus.QUEUED,
          }),
        ),
      );
      await this.runRepository.update(run.id, {
        totalPages: items.length,
        status: CrawlRunStatus.PROCESSING,
        startedAt: new Date(),
      });
      await this.documentRepository.update(
        urlDocuments.map((document) => document.id),
        {
          reindexStatus: DocumentReindexStatus.QUEUED,
          reindexError: null,
        },
      );
      await Promise.all(items.map((item) => this.enqueuePage(item.id)));
      queued += items.length;
    }

    for (const document of fileDocuments) {
      try {
        await this.documentService.enqueueFileReindex(
          siteId,
          document,
          user,
          site,
        );
        queued += 1;
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
    }

    return {
      queued,
      skipped: outdated.length - queued,
      totalOutdated: outdated.length,
    };
  }

  async retryFailed(siteId: string, runId: string, user: JwtUser) {
    this.assertFeatureEnabled();
    await this.siteService.assertSiteAccess(siteId, user);
    const sourceRun = await this.runRepository.findOne({
      where: { id: runId, siteId },
    });
    if (!sourceRun) throw new NotFoundException('Crawl run not found');
    const failedItems = await this.itemRepository.find({
      where: {
        runId,
        status: In([
          CrawlRunItemStatus.FAILED,
          CrawlRunItemStatus.QUOTA_EXCEEDED,
        ]),
      },
    });
    if (failedItems.length === 0) {
      throw new ConflictException('Crawl run has no failed URLs to retry');
    }
    const run = await this.createRun({
      siteId,
      crawlerConfigId: sourceRun.crawlerConfigId,
      requestedByUserId: user.id,
      trigger: CrawlRunTrigger.RETRY_FAILED,
      targetUrl: sourceRun.targetUrl,
    });
    const items = await this.itemRepository.save(
      failedItems.map((item) =>
        this.itemRepository.create({
          runId: run.id,
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          sitemapLastModified: item.sitemapLastModified,
          status: CrawlRunItemStatus.QUEUED,
        }),
      ),
    );
    await this.runRepository.update(run.id, {
      totalPages: items.length,
      status: CrawlRunStatus.PROCESSING,
      startedAt: new Date(),
    });
    await Promise.all(items.map((item) => this.enqueuePage(item.id)));
    return { runId: run.id, status: CrawlRunStatus.PROCESSING };
  }

  async listRuns(siteId: string, page: number, limit: number, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const [data, total] = await this.runRepository.findAndCount({
      where: { siteId },
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
    return { data, total, page: safePage, limit: safeLimit };
  }

  async getRun(siteId: string, runId: string, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    const run = await this.runRepository.findOne({
      where: { id: runId, siteId },
    });
    if (!run) throw new NotFoundException('Crawl run not found');
    return run;
  }

  async listRunPages(
    siteId: string,
    runId: string,
    query: {
      page?: number;
      limit?: number;
      status?: CrawlRunItemStatus;
      search?: string;
    },
    user: JwtUser,
  ) {
    await this.getRun(siteId, runId, user);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const qb = this.itemRepository
      .createQueryBuilder('item')
      .where('item.runId = :runId', { runId });
    if (query.status)
      qb.andWhere('item.status = :status', { status: query.status });
    if (query.search) {
      qb.andWhere('item.url ILIKE :search', { search: `%${query.search}%` });
    }
    const [data, total] = await qb
      .orderBy('item.createdAt', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  async startScheduled(crawlerConfigId: string): Promise<void> {
    const config = await this.configRepository.findOne({
      where: { id: crawlerConfigId, autoSyncEnabled: true },
    });
    if (!config || (await this.findActiveRun(config.siteId))) return;
    const run = await this.runRepository.save(
      this.runRepository.create({
        siteId: config.siteId,
        crawlerConfigId: config.id,
        requestedByUserId: null,
        trigger: CrawlRunTrigger.SCHEDULED,
        status: CrawlRunStatus.QUEUED,
        targetUrl: config.sitemapUrl,
      }),
    );
    await this.queue.add(
      CRAWL_SITEMAP_JOB,
      { runId: run.id },
      this.sitemapJobOptions(run.id),
    );
  }

  private async createRun(input: Partial<CrawlRun>): Promise<CrawlRun> {
    const active = await this.findActiveRun(input.siteId!);
    if (active) {
      const error = new ConflictException({
        code: 'CRAWL_ALREADY_RUNNING',
        activeRunId: active.id,
        message: 'A crawl is already running for this site',
      });
      throw error;
    }
    try {
      return await this.runRepository.save(
        this.runRepository.create({ ...input, status: CrawlRunStatus.QUEUED }),
      );
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === '23505'
      ) {
        const concurrentRun = await this.findActiveRun(input.siteId!);
        throw new ConflictException({
          code: 'CRAWL_ALREADY_RUNNING',
          activeRunId: concurrentRun?.id,
          message: 'A crawl is already running for this site',
        });
      }
      throw error;
    }
  }

  private assertReindexable(document: Document): void {
    if (document.status !== DocumentStatus.READY) {
      throw new ConflictException('Only ready documents can be re-indexed');
    }
    if (
      [DocumentReindexStatus.QUEUED, DocumentReindexStatus.PROCESSING].includes(
        document.reindexStatus,
      )
    ) {
      throw new ConflictException('Document re-index is already in progress');
    }
  }

  private findActiveRun(siteId: string): Promise<CrawlRun | null> {
    return this.runRepository.findOne({
      where: { siteId, status: In(ACTIVE_CRAWL_RUN_STATUSES) },
      order: { createdAt: 'DESC' },
    });
  }

  private enqueuePage(runItemId: string) {
    return this.queue.add(
      CRAWL_PAGE_JOB,
      { runItemId },
      {
        jobId: runItemId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  private sitemapJobOptions(runId: string) {
    return {
      jobId: `sitemap-${runId}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    };
  }

  private async syncRepeatableJob(config: CrawlerConfig): Promise<void> {
    const repeatable = await this.queue.getRepeatableJobs();
    for (const job of repeatable) {
      if (job.id === `crawler-config-${config.id}`) {
        await this.queue.removeRepeatableByKey(job.key);
      }
    }
    if (config.autoSyncEnabled) {
      await this.queue.add(
        SCHEDULED_CRAWL_JOB,
        { crawlerConfigId: config.id },
        {
          jobId: `crawler-config-${config.id}`,
          repeat: { every: CRAWLER_INTERVAL_MS },
          removeOnComplete: true,
        },
      );
    }
  }

  async removeSiteRepeatableJob(siteId: string): Promise<void> {
    try {
      const config = await this.configRepository.findOne({ where: { siteId } });
      if (config) {
        const repeatable = await this.queue.getRepeatableJobs();
        for (const job of repeatable) {
          if (job.id === `crawler-config-${config.id}`) {
            await this.queue.removeRepeatableByKey(job.key);
          }
        }
      }
    } catch {
      // Ignore errors if crawler queue or config is missing during deletion
    }
  }

  private assertFeatureEnabled(): void {
    if (!this.isFeatureEnabled()) {
      throw new ServiceUnavailableException('Crawler feature is disabled');
    }
  }

  private isFeatureEnabled(): boolean {
    return (
      process.env.CRAWLER_ENABLED === 'true' ||
      (!process.env.CRAWLER_ENABLED && process.env.NODE_ENV !== 'production')
    );
  }
}
