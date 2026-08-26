import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bull';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
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
  TERMINAL_CRAWL_ITEM_STATUSES,
} from './enums/crawler.enums';
import { CrawlerUrlService } from './services/crawler-url.service';

@Injectable()
export class CrawlerService implements OnModuleInit {
  private readonly logger = new Logger(CrawlerService.name);

  constructor(
    @InjectRepository(CrawlerConfig)
    private readonly configRepository: Repository<CrawlerConfig>,
    @InjectRepository(CrawlRun)
    private readonly runRepository: Repository<CrawlRun>,
    @InjectRepository(CrawlRunItem)
    private readonly itemRepository: Repository<CrawlRunItem>,
    private readonly dataSource: DataSource,
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
    await this.recoverOrphanedRuns();
  }

  @Cron('*/5 * * * *')
  async handleOrphanedRunRecovery(): Promise<void> {
    if (!this.isFeatureEnabled()) return;
    try {
      await this.recoverOrphanedRuns();
    } catch (error) {
      this.logger.error(
        `Periodic orphaned run recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    const runInput: Partial<CrawlRun> = {
      siteId,
      crawlerConfigId: null,
      requestedByUserId: user.id,
      trigger,
      targetUrl: normalizedUrl,
    };

    let run: CrawlRun;
    let item: CrawlRunItem;
    let isWaiting = false;

    try {
      run = await this.createRun(runInput);
    } catch (error) {
      if (
        trigger !== CrawlRunTrigger.MANUAL_URL ||
        !(error instanceof ConflictException)
      ) {
        throw error;
      }
      ({ run, item } = await this.createWaitingManualUrlRun(
        runInput,
        normalizedUrl,
      ));
      isWaiting = true;
    }

    if (isWaiting) {
      const startedRunId = await this.startNextWaitingRun(siteId);
      return {
        runId: run.id,
        status:
          startedRunId === run.id
            ? CrawlRunStatus.PROCESSING
            : CrawlRunStatus.WAITING,
      };
    }
    item = await this.itemRepository.save(
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

  async deleteFailedItem(
    siteId: string,
    runId: string,
    itemId: string,
    user: JwtUser,
  ) {
    this.assertFeatureEnabled();
    await this.siteService.assertSiteAccess(siteId, user);
    const run = await this.runRepository.findOne({
      where: { id: runId, siteId },
    });
    if (!run) throw new NotFoundException('Crawl run not found');

    const item = await this.itemRepository.findOne({
      where: { id: itemId, runId },
    });
    if (!item) throw new NotFoundException('Crawl run item not found');

    if (
      item.status !== CrawlRunItemStatus.FAILED &&
      item.status !== CrawlRunItemStatus.QUOTA_EXCEEDED
    ) {
      throw new ConflictException('Can only delete failed crawl items');
    }

    await this.itemRepository.remove(item);

    if (item.status === CrawlRunItemStatus.FAILED) {
      run.failedPages = Math.max(0, run.failedPages - 1);
    } else if (item.status === CrawlRunItemStatus.QUOTA_EXCEEDED) {
      run.quotaExceededPages = Math.max(0, run.quotaExceededPages - 1);
    }
    run.totalPages = Math.max(0, run.totalPages - 1);
    run.processedPages = Math.max(0, run.processedPages - 1);
    await this.runRepository.save(run);

    return { success: true };
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

  private createWaitingManualUrlRun(
    runInput: Partial<CrawlRun>,
    normalizedUrl: string,
  ): Promise<{ run: CrawlRun; item: CrawlRunItem }> {
    return this.dataSource.transaction(async (manager) => {
      const runRepository = manager.getRepository(CrawlRun);
      const itemRepository = manager.getRepository(CrawlRunItem);
      const run = await runRepository.save(
        runRepository.create({
          ...runInput,
          status: CrawlRunStatus.WAITING,
          totalPages: 1,
        }),
      );
      const item = await itemRepository.save(
        itemRepository.create({
          runId: run.id,
          url: normalizedUrl,
          normalizedUrl,
          status: CrawlRunItemStatus.QUEUED,
        }),
      );
      return { run, item };
    });
  }

  async startNextWaitingRun(siteId: string): Promise<string | null> {
    if (await this.findActiveRun(siteId)) return null;

    const waitingRun = await this.runRepository.findOne({
      where: { siteId, status: CrawlRunStatus.WAITING },
      order: { createdAt: 'ASC' },
    });
    if (!waitingRun) return null;

    try {
      const claimed = await this.runRepository.update(
        { id: waitingRun.id, status: CrawlRunStatus.WAITING },
        {
          status: CrawlRunStatus.PROCESSING,
          startedAt: new Date(),
          errorMessage: null,
        },
      );
      if (claimed.affected !== 1) return null;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error as { code?: string }).code === '23505'
      ) {
        return null;
      }
      throw error;
    }

    const items = await this.itemRepository.find({
      where: {
        runId: waitingRun.id,
        status: In([CrawlRunItemStatus.QUEUED, CrawlRunItemStatus.RENDERING]),
      },
      order: { createdAt: 'ASC' },
    });

    if (items.length === 0) {
      await this.runRepository.update(waitingRun.id, {
        status: CrawlRunStatus.FAILED,
        errorMessage: 'Waiting crawl has no URL item',
        finishedAt: new Date(),
      });
      return this.startNextWaitingRun(siteId);
    }

    for (const item of items) {
      if (item.status !== CrawlRunItemStatus.QUEUED) {
        await this.itemRepository.update(item.id, {
          status: CrawlRunItemStatus.QUEUED,
        });
      }
      try {
        await this.enqueuePage(item.id);
      } catch (error) {
        this.logger.error(
          `Failed to enqueue waiting crawl item ${item.id}; recovery will retry: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return waitingRun.id;
  }

  private enqueuePage(runItemId: string) {
    return this.queue.add(
      CRAWL_PAGE_JOB,
      { runItemId },
      {
        jobId: runItemId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        timeout: 120_000,
        removeOnComplete: true,
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      },
    );
  }

  private sitemapJobOptions(runId: string) {
    return {
      jobId: `sitemap-${runId}`,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: { count: 200, age: 7 * 24 * 3600 },
    };
  }

  async recoverOrphanedRuns(): Promise<void> {
    const activeRuns = await this.runRepository.find({
      where: { status: In(ACTIVE_CRAWL_RUN_STATUSES) },
      order: { createdAt: 'ASC' },
    });
    if (activeRuns.length > 0) {
      this.logger.log(
        `Found ${activeRuns.length} active crawl run(s) to inspect for recovery`,
      );
    }

    for (const run of activeRuns) {
      const isSitemapDiscovery =
        run.status === CrawlRunStatus.QUEUED ||
        run.status === CrawlRunStatus.DISCOVERING ||
        (run.totalPages === 0 &&
          [CrawlRunTrigger.MANUAL_SITEMAP, CrawlRunTrigger.SCHEDULED].includes(
            run.trigger,
          ));

      if (isSitemapDiscovery) {
        const sitemapJobId = `sitemap-${run.id}`;
        const existingJob = await this.queue.getJob(sitemapJobId);
        const isJobActiveOrWaiting =
          existingJob &&
          !(await existingJob.isFailed()) &&
          !(await existingJob.isCompleted());

        if (!isJobActiveOrWaiting) {
          if (existingJob) {
            await existingJob.remove().catch(() => undefined);
          }
          this.logger.log(
            `Re-enqueuing orphaned sitemap job for run ${run.id}`,
          );
          await this.queue.add(
            CRAWL_SITEMAP_JOB,
            { runId: run.id },
            this.sitemapJobOptions(run.id),
          );
        }
        continue;
      }

      const pendingItems = await this.itemRepository.find({
        where: {
          runId: run.id,
          status: In([CrawlRunItemStatus.QUEUED, CrawlRunItemStatus.RENDERING]),
        },
      });

      if (pendingItems.length === 0 && run.totalPages > 0) {
        const terminalCount = await this.itemRepository.count({
          where: {
            runId: run.id,
            status: In(TERMINAL_CRAWL_ITEM_STATUSES),
          },
        });
        if (terminalCount >= run.totalPages) {
          const failedCount = await this.itemRepository.count({
            where: {
              runId: run.id,
              status: In([
                CrawlRunItemStatus.FAILED,
                CrawlRunItemStatus.QUOTA_EXCEEDED,
              ]),
            },
          });
          const successCount = await this.itemRepository.count({
            where: {
              runId: run.id,
              status: In([
                CrawlRunItemStatus.INDEXED,
                CrawlRunItemStatus.UNCHANGED,
                CrawlRunItemStatus.SKIPPED_ROBOTS,
                CrawlRunItemStatus.SKIPPED_NOINDEX,
              ]),
            },
          });
          let finalStatus = CrawlRunStatus.COMPLETED;
          if (failedCount > 0) {
            finalStatus =
              successCount > 0
                ? CrawlRunStatus.PARTIAL_FAILED
                : CrawlRunStatus.FAILED;
          }
          this.logger.log(
            `Marking fully processed run ${run.id} as ${finalStatus}`,
          );
          await this.runRepository.update(run.id, {
            status: finalStatus,
            finishedAt: new Date(),
          });
          continue;
        }
      }

      let reEnqueuedCount = 0;
      for (const item of pendingItems) {
        const existingJob = await this.queue.getJob(item.id);
        const isJobActiveOrWaiting =
          existingJob &&
          !(await existingJob.isFailed()) &&
          !(await existingJob.isCompleted());

        if (!isJobActiveOrWaiting) {
          if (existingJob) {
            await existingJob.remove().catch(() => undefined);
          }
          if (item.status !== CrawlRunItemStatus.QUEUED) {
            await this.itemRepository.update(item.id, {
              status: CrawlRunItemStatus.QUEUED,
            });
          }
          await this.enqueuePage(item.id);
          reEnqueuedCount++;
        }
      }
      if (reEnqueuedCount > 0) {
        this.logger.log(
          `Re-enqueued ${reEnqueuedCount} orphaned page job(s) for run ${run.id}`,
        );
      }
    }

    const waitingRuns = await this.runRepository.find({
      where: { status: CrawlRunStatus.WAITING },
      order: { createdAt: 'ASC' },
      select: { siteId: true },
    });
    const waitingSiteIds = [...new Set(waitingRuns.map((run) => run.siteId))];
    for (const waitingSiteId of waitingSiteIds) {
      await this.startNextWaitingRun(waitingSiteId);
    }
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
