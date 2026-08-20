import {
  OnQueueFailed,
  OnQueueStalled,
  Process,
  Processor,
} from '@nestjs/bull';
import { BadRequestException, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job, Queue } from 'bull';
import { Repository } from 'typeorm';
import { Document } from '../document/entities/document.entity';
import { DocumentReindexStatus } from '../document/enums/document-reindex-status.enum';
import { Site } from '../site/entities/site.entity';
import {
  CRAWLER_QUEUE,
  CRAWL_PAGE_JOB,
  CRAWL_SITEMAP_JOB,
  SCHEDULED_CRAWL_JOB,
} from './constants/crawler.constants';
import { CrawlerService } from './crawler.service';
import { CrawlerConfig } from './entities/crawler-config.entity';
import { CrawlRunItem } from './entities/crawl-run-item.entity';
import { CrawlRun } from './entities/crawl-run.entity';
import {
  CrawlRunItemStatus,
  CrawlRunStatus,
  CrawlRunTrigger,
  TERMINAL_CRAWL_ITEM_STATUSES,
} from './enums/crawler.enums';
import {
  CrawlerHttpStatusError,
  CrawlerQuotaExceededError,
} from './errors/crawler.errors';
import { CrawlerHttpService } from './services/crawler-http.service';
import { CrawlerIndexingService } from './services/crawler-indexing.service';
import { CrawlerUrlService } from './services/crawler-url.service';
import { HostLockService } from './services/host-lock.service';
import { PageExtractorService } from './services/page-extractor.service';
import { PageRendererService } from './services/page-renderer.service';
import { RobotsService } from './services/robots.service';
import { SitemapService } from './services/sitemap.service';
import type {
  CrawlPageJobData,
  CrawlSitemapJobData,
  ScheduledCrawlJobData,
} from './types/crawler-job.type';

@Processor(CRAWLER_QUEUE)
export class CrawlerProcessor {
  private readonly logger = new Logger(CrawlerProcessor.name);

  constructor(
    @InjectRepository(CrawlerConfig)
    private readonly configRepository: Repository<CrawlerConfig>,
    @InjectRepository(CrawlRun)
    private readonly runRepository: Repository<CrawlRun>,
    @InjectRepository(CrawlRunItem)
    private readonly itemRepository: Repository<CrawlRunItem>,
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectQueue(CRAWLER_QUEUE)
    private readonly queue: Queue,
    private readonly crawlerService: CrawlerService,
    private readonly sitemapService: SitemapService,
    private readonly robotsService: RobotsService,
    private readonly renderer: PageRendererService,
    private readonly extractor: PageExtractorService,
    private readonly indexing: CrawlerIndexingService,
    private readonly urlService: CrawlerUrlService,
    private readonly http: CrawlerHttpService,
    private readonly hostLock: HostLockService,
  ) {}

  @Process(SCHEDULED_CRAWL_JOB)
  async handleScheduled(job: Job<ScheduledCrawlJobData>): Promise<void> {
    await this.crawlerService.startScheduled(job.data.crawlerConfigId);
  }

  @Process(CRAWL_SITEMAP_JOB)
  async handleSitemap(job: Job<CrawlSitemapJobData>): Promise<void> {
    const run = await this.runRepository.findOne({
      where: { id: job.data.runId },
    });
    if (!run) return;
    const site = await this.siteRepository.findOne({
      where: { id: run.siteId },
    });
    if (!site) {
      await this.failRun(run.id, 'Site not found');
      return;
    }
    await this.runRepository.update(run.id, {
      status: CrawlRunStatus.DISCOVERING,
      startedAt: run.startedAt ?? new Date(),
      errorMessage: null,
    });
    try {
      const urls = await this.sitemapService.discover(run.targetUrl);
      await this.runRepository.update(run.id, {
        totalPages: urls.length,
        status: CrawlRunStatus.PROCESSING,
      });
      if (urls.length === 0) {
        await this.finishRun(run.id);
        return;
      }
      await this.itemRepository.delete({ runId: run.id });
      for (let start = 0; start < urls.length; start += 500) {
        const batch = urls.slice(start, start + 500).map((entry) =>
          this.itemRepository.create({
            runId: run.id,
            url: entry.url,
            normalizedUrl: entry.normalizedUrl,
            sitemapLastModified: entry.lastModified,
            status: CrawlRunItemStatus.QUEUED,
          }),
        );
        const items = await this.itemRepository.save(batch);
        await this.queue.addBulk(
          items.map((item) => ({
            name: CRAWL_PAGE_JOB,
            data: { runItemId: item.id } satisfies CrawlPageJobData,
            opts: {
              jobId: item.id,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5_000 },
              timeout: 120_000,
              removeOnComplete: true,
              removeOnFail: { count: 200, age: 7 * 24 * 3600 },
            },
          })),
        );
      }
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`Sitemap crawl ${run.id} failed: ${message}`);
      await this.failRun(run.id, message);
    }
  }

  @Process({
    name: CRAWL_PAGE_JOB,
    concurrency: parseInt(process.env.CRAWLER_CONCURRENCY || '2', 10),
  })
  async handlePage(job: Job<CrawlPageJobData>): Promise<void> {
    const item = await this.itemRepository.findOne({
      where: { id: job.data.runItemId },
      relations: { run: true },
    });
    if (!item) return;
    const run = item.run;
    if (
      ![
        CrawlRunStatus.QUEUED,
        CrawlRunStatus.DISCOVERING,
        CrawlRunStatus.PROCESSING,
      ].includes(run.status)
    ) {
      return;
    }
    if (run.errorMessage === 'VECTOR_QUOTA_EXCEEDED') {
      await this.completeItem(item.id, CrawlRunItemStatus.QUOTA_EXCEEDED, {
        errorCode: 'VECTOR_QUOTA_EXCEEDED',
        errorMessage: 'Knowledge base vector quota has been reached',
      });
      return;
    }
    const site = await this.siteRepository.findOne({
      where: { id: run.siteId },
    });
    if (!site) {
      await this.completeItem(item.id, CrawlRunItemStatus.FAILED, {
        errorCode: 'SITE_NOT_FOUND',
        errorMessage: 'Site not found',
      });
      return;
    }
    const forceReindex = run.trigger === CrawlRunTrigger.RECRAWL_PAGE;
    try {
      await this.urlService.assertPublicUrl(item.url);
      await this.itemRepository.update(item.id, {
        status: CrawlRunItemStatus.RENDERING,
        startedAt: item.startedAt ?? new Date(),
        errorCode: null,
        errorMessage: null,
      });
      const existing = await this.indexing.findExisting(
        run.siteId,
        item.normalizedUrl,
      );
      if (forceReindex && existing) {
        await this.documentRepository.update(existing.id, {
          reindexStatus: DocumentReindexStatus.PROCESSING,
          reindexError: null,
        });
      }
      const allowed = await this.robotsService.isAllowed(item.url);
      if (!allowed) {
        await this.completeItem(item.id, CrawlRunItemStatus.SKIPPED_ROBOTS);
        if (forceReindex && existing) {
          await this.documentRepository.update(existing.id, {
            reindexStatus: DocumentReindexStatus.FAILED,
            reindexError: 'Re-index was blocked by robots.txt',
          });
        }
        return;
      }
      if (
        !forceReindex &&
        existing &&
        (await this.http.isNotModified(
          item.url,
          new URL(item.url).hostname,
          existing.etag,
          existing.lastModified,
        ))
      ) {
        await this.indexing.markUnchanged(existing, {
          sourceUrl: item.url,
          canonicalUrl: existing.canonicalUrl,
          etag: existing.etag,
          lastModified: existing.lastModified,
        });
        await this.completeItem(item.id, CrawlRunItemStatus.UNCHANGED, {
          documentId: existing.id,
          canonicalUrl: existing.canonicalUrl,
          httpStatus: 304,
          etag: existing.etag,
          lastModified: existing.lastModified,
        });
        return;
      }

      const delay = await this.robotsService.crawlDelayMs(item.url);
      await this.hostLock.runExclusive(
        new URL(item.url).hostname,
        delay,
        async () => {
          const rendered = await this.renderer.render(item.url);
          if (rendered.httpStatus >= 400) {
            throw new CrawlerHttpStatusError(rendered.httpStatus);
          }
          const extracted = this.extractor.extract(
            rendered.html,
            rendered.finalUrl,
          );
          if (extracted.noindex) {
            await this.completeItem(
              item.id,
              CrawlRunItemStatus.SKIPPED_NOINDEX,
              {
                httpStatus: rendered.httpStatus,
                etag: rendered.etag,
                lastModified: rendered.lastModified,
              },
            );
            if (forceReindex && existing) {
              await this.documentRepository.update(existing.id, {
                reindexStatus: DocumentReindexStatus.FAILED,
                reindexError:
                  'Re-index was blocked by the page noindex directive',
              });
            }
            return;
          }
          let canonicalUrl: string | null = null;
          if (extracted.canonicalUrl) {
            try {
              const canonical = new URL(extracted.canonicalUrl);
              if (
                canonical.hostname.toLowerCase() ===
                new URL(rendered.finalUrl).hostname.toLowerCase()
              ) {
                canonicalUrl = this.urlService.normalize(canonical.toString());
              }
            } catch {
              canonicalUrl = null;
            }
          }
          const matchedDocument =
            existing ??
            (canonicalUrl
              ? await this.indexing.findExistingByCanonical(
                  run.siteId,
                  canonicalUrl,
                )
              : null);
          if (
            !forceReindex &&
            matchedDocument?.contentHash === extracted.contentHash
          ) {
            const isCanonicalAlias =
              matchedDocument.normalizedUrl !== item.normalizedUrl;
            const document = await this.indexing.markUnchanged(
              matchedDocument,
              {
                sourceUrl: isCanonicalAlias
                  ? (matchedDocument.sourceUrl ?? item.url)
                  : item.url,
                canonicalUrl,
                etag: rendered.etag,
                lastModified: rendered.lastModified,
              },
            );
            await this.completeItem(item.id, CrawlRunItemStatus.UNCHANGED, {
              documentId: document.id,
              canonicalUrl,
              httpStatus: rendered.httpStatus,
              etag: rendered.etag,
              lastModified: rendered.lastModified,
            });
            return;
          }
          const document = await this.indexing.index(
            {
              siteId: run.siteId,
              crawlerConfigId: run.crawlerConfigId,
              sourceUrl: item.url,
              normalizedUrl: item.normalizedUrl,
              canonicalUrl,
              title: extracted.title,
              content: extracted.content,
              contentHash: extracted.contentHash,
              etag: rendered.etag,
              lastModified: rendered.lastModified,
            },
            matchedDocument,
          );
          if (forceReindex) {
            await this.documentRepository.update(document.id, {
              reindexStatus: DocumentReindexStatus.IDLE,
              reindexError: null,
            });
          }
          await this.completeItem(item.id, CrawlRunItemStatus.INDEXED, {
            documentId: document.id,
            canonicalUrl,
            httpStatus: rendered.httpStatus,
            etag: rendered.etag,
            lastModified: rendered.lastModified,
          });
        },
      );
    } catch (error) {
      if (error instanceof CrawlerQuotaExceededError) {
        await this.runRepository.update(run.id, {
          errorMessage: 'VECTOR_QUOTA_EXCEEDED',
        });
        await this.completeItem(item.id, CrawlRunItemStatus.QUOTA_EXCEEDED, {
          errorCode: 'VECTOR_QUOTA_EXCEEDED',
          errorMessage: error.message,
        });
        if (forceReindex) {
          const existing = await this.indexing.findExisting(
            run.siteId,
            item.normalizedUrl,
          );
          if (existing) {
            await this.documentRepository.update(existing.id, {
              reindexStatus: DocumentReindexStatus.FAILED,
              reindexError: error.message,
            });
          }
        }
        return;
      }
      const maxAttempts = Number(job.opts.attempts ?? 1);
      if (this.isRetriable(error) && job.attemptsMade + 1 < maxAttempts) {
        await this.itemRepository.update(item.id, {
          status: CrawlRunItemStatus.QUEUED,
          errorCode: this.errorCode(error),
          errorMessage: this.errorMessage(error),
        });
        throw error;
      }
      await this.completeItem(item.id, CrawlRunItemStatus.FAILED, {
        httpStatus:
          error instanceof CrawlerHttpStatusError ? error.status : null,
        errorCode: this.errorCode(error),
        errorMessage: this.errorMessage(error),
      });
      if (forceReindex) {
        const existing = await this.indexing.findExisting(
          run.siteId,
          item.normalizedUrl,
        );
        if (existing) {
          await this.documentRepository.update(existing.id, {
            reindexStatus: DocumentReindexStatus.FAILED,
            reindexError: this.errorMessage(error),
          });
        }
      }
    }
  }

  private async completeItem(
    itemId: string,
    status: CrawlRunItemStatus,
    fields: Partial<
      Pick<
        CrawlRunItem,
        | 'documentId'
        | 'canonicalUrl'
        | 'httpStatus'
        | 'etag'
        | 'lastModified'
        | 'errorCode'
        | 'errorMessage'
      >
    > = {},
  ): Promise<void> {
    const item = await this.itemRepository.findOne({ where: { id: itemId } });
    if (!item) return;
    await this.itemRepository.update(itemId, {
      ...fields,
      status,
      finishedAt: new Date(),
    });
    await this.refreshRun(item.runId);
  }

  private async refreshRun(runId: string): Promise<void> {
    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run) return;
    const rows = await this.itemRepository
      .createQueryBuilder('item')
      .select('item.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('item.runId = :runId', { runId })
      .groupBy('item.status')
      .getRawMany<{ status: CrawlRunItemStatus; count: string }>();
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    const count = (status: CrawlRunItemStatus) => counts.get(status) ?? 0;
    const processedPages = TERMINAL_CRAWL_ITEM_STATUSES.reduce(
      (sum, status) => sum + count(status),
      0,
    );
    const failedPages = count(CrawlRunItemStatus.FAILED);
    const quotaExceededPages = count(CrawlRunItemStatus.QUOTA_EXCEEDED);
    const indexedPages = count(CrawlRunItemStatus.INDEXED);
    const unchangedPages = count(CrawlRunItemStatus.UNCHANGED);
    const skippedPages =
      count(CrawlRunItemStatus.SKIPPED_ROBOTS) +
      count(CrawlRunItemStatus.SKIPPED_NOINDEX);
    await this.runRepository.update(runId, {
      processedPages,
      failedPages,
      quotaExceededPages,
      indexedPages,
      unchangedPages,
      skippedPages,
    });
    if (processedPages >= run.totalPages) await this.finishRun(runId);
  }

  private async finishRun(runId: string): Promise<void> {
    const run = await this.runRepository.findOne({ where: { id: runId } });
    if (!run) return;
    let status = CrawlRunStatus.COMPLETED;
    if (run.failedPages > 0 || run.quotaExceededPages > 0) {
      status =
        run.indexedPages + run.unchangedPages + run.skippedPages > 0
          ? CrawlRunStatus.PARTIAL_FAILED
          : CrawlRunStatus.FAILED;
    }
    const finishedAt = new Date();
    await this.runRepository.update(runId, { status, finishedAt });
    if (run.crawlerConfigId) {
      const config = await this.configRepository.findOne({
        where: { id: run.crawlerConfigId },
      });
      await this.configRepository.update(run.crawlerConfigId, {
        lastRunAt: finishedAt,
        nextRunAt: config?.autoSyncEnabled
          ? new Date(finishedAt.getTime() + 7 * 24 * 60 * 60 * 1000)
          : null,
      });
    }
    if (
      status === CrawlRunStatus.COMPLETED &&
      run.crawlerConfigId &&
      [CrawlRunTrigger.MANUAL_SITEMAP, CrawlRunTrigger.SCHEDULED].includes(
        run.trigger,
      )
    ) {
      await this.applyMissingPolicy(runId, run.crawlerConfigId);
    }
  }

  private async applyMissingPolicy(
    runId: string,
    crawlerConfigId: string,
  ): Promise<void> {
    const [items, documents] = await Promise.all([
      this.itemRepository.find({
        where: { runId },
        select: { normalizedUrl: true, documentId: true },
      }),
      this.documentRepository.find({ where: { crawlerConfigId } }),
    ]);
    const seen = new Set(items.map((item) => item.normalizedUrl));
    const seenDocumentIds = new Set(
      items.flatMap((item) => (item.documentId ? [item.documentId] : [])),
    );
    for (const document of documents) {
      if (
        seenDocumentIds.has(document.id) ||
        (document.normalizedUrl && seen.has(document.normalizedUrl))
      ) {
        await this.documentRepository.update(document.id, {
          consecutiveMissingRuns: 0,
          isActive: true,
        });
      } else {
        const missing = document.consecutiveMissingRuns + 1;
        await this.documentRepository.update(document.id, {
          consecutiveMissingRuns: missing,
          isActive: missing < 2,
        });
      }
    }
  }

  private async failRun(runId: string, message: string): Promise<void> {
    await this.runRepository.update(runId, {
      status: CrawlRunStatus.FAILED,
      errorMessage: message,
      finishedAt: new Date(),
    });
  }

  private isRetriable(error: unknown): boolean {
    if (error instanceof BadRequestException) return false;
    if (error instanceof CrawlerHttpStatusError) {
      return [408, 429].includes(error.status) || error.status >= 500;
    }
    return true;
  }

  private errorCode(error: unknown): string {
    if (error instanceof CrawlerHttpStatusError) return `HTTP_${error.status}`;
    if (error instanceof Error) return error.name.slice(0, 100);
    return 'CRAWLER_ERROR';
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      2000,
    );
  }

  @OnQueueFailed()
  async onFailed(job: Job, error: Error): Promise<void> {
    this.logger.error(
      `Job ${job.id} (${job.name}) failed after ${job.attemptsMade} attempt(s): ${error.message}`,
      error.stack,
    );
    if (job.name === CRAWL_PAGE_JOB) {
      const data = job.data as CrawlPageJobData;
      try {
        const item = await this.itemRepository.findOne({
          where: { id: data.runItemId },
        });
        if (item && !TERMINAL_CRAWL_ITEM_STATUSES.includes(item.status)) {
          await this.completeItem(item.id, CrawlRunItemStatus.FAILED, {
            errorCode: 'UNHANDLED_FAILURE',
            errorMessage: error.message?.slice(0, 2000),
          });
        }
      } catch (dbError) {
        this.logger.error(
          `Failed to update DB for failed job ${job.id}: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
        );
      }
    }
  }

  @OnQueueStalled()
  onStalled(job: Job): void {
    this.logger.warn(
      `Job ${job.id} (${job.name}) stalled — Bull will retry automatically`,
    );
  }
}
