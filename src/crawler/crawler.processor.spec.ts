jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));
jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));

import { CrawlerProcessor } from './crawler.processor';
import {
  CrawlRunItemStatus,
  CrawlRunStatus,
  CrawlRunTrigger,
} from './enums/crawler.enums';

describe('CrawlerProcessor external sources', () => {
  function createSubject(trigger = CrawlRunTrigger.MANUAL_URL) {
    const run = {
      id: 'run-id',
      siteId: 'site-id',
      crawlerConfigId: null,
      status: CrawlRunStatus.PROCESSING,
      totalPages: 2,
      processedPages: 0,
      indexedPages: 0,
      unchangedPages: 0,
      skippedPages: 0,
      failedPages: 0,
      quotaExceededPages: 0,
      errorMessage: null,
      startedAt: null,
      trigger,
    };
    const item = {
      id: 'item-id',
      runId: run.id,
      run,
      url: 'https://external.example/page',
      normalizedUrl: 'https://external.example/page',
      startedAt: null,
    };
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest
        .fn()
        .mockResolvedValue([
          { status: CrawlRunItemStatus.INDEXED, count: '1' },
        ]),
    };
    const configRepository = { findOne: jest.fn(), update: jest.fn() };
    const runRepository = {
      findOne: jest.fn().mockResolvedValue(run),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const itemRepository = {
      findOne: jest.fn().mockResolvedValue(item),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((val: Record<string, unknown>) => val),
      save: jest.fn((val: Record<string, unknown>[]) =>
        Promise.resolve(val.map((item, i) => ({ id: `item-${i}`, ...item }))),
      ),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const siteRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'site-id',
        url: 'https://primary.example.com',
      }),
    };
    const queue = {
      addBulk: jest.fn().mockResolvedValue(undefined),
    };
    const sitemapService = {
      discover: jest.fn().mockResolvedValue([
        {
          url: 'https://external.example/p1',
          normalizedUrl: 'https://external.example/p1',
          lastModified: null,
        },
      ]),
    };
    const renderer = {
      render: jest.fn().mockResolvedValue({
        html: '<main>External content</main>',
        finalUrl: 'https://external.example/page',
        httpStatus: 200,
        etag: null,
        lastModified: null,
      }),
    };
    const extractor = {
      extract: jest.fn().mockReturnValue({
        title: 'External page',
        content: 'External content long enough to index safely.',
        contentHash: 'hash',
        canonicalUrl: 'https://canonical.other.example/page',
        noindex: false,
      }),
    };
    const indexing = {
      findExisting: jest.fn().mockResolvedValue(null),
      findExistingByCanonical: jest.fn().mockResolvedValue(null),
      index: jest.fn().mockResolvedValue({ id: 'document-id' }),
    };
    const urlService = {
      assertPublicUrl: jest
        .fn()
        .mockImplementation((url: string) => Promise.resolve(new URL(url))),
      normalize: jest.fn((url: string) => url),
    };
    const hostLock = {
      runExclusive: jest.fn(
        async (
          _hostname: string,
          _delay: number,
          action: () => Promise<void>,
        ) => action(),
      ),
    };

    const documentRepository = {
      update: jest.fn().mockResolvedValue(undefined),
    };
    const http = { isNotModified: jest.fn().mockResolvedValue(true) };
    const processor = new CrawlerProcessor(
      configRepository as never,
      runRepository as never,
      itemRepository as never,
      documentRepository as never,
      siteRepository as never,
      queue as never,
      {} as never,
      sitemapService as never,
      {
        isAllowed: jest.fn().mockResolvedValue(true),
        crawlDelayMs: jest.fn().mockResolvedValue(0),
      } as never,
      renderer as never,
      extractor,
      indexing as never,
      urlService as never,
      http as never,
      hostLock as never,
    );

    return {
      processor,
      indexing,
      itemRepository,
      runRepository,
      queue,
      sitemapService,
      renderer,
      urlService,
      documentRepository,
      http,
    };
  }

  it('indexes an external page while rejecting a cross-host canonical alias', async () => {
    const subject = createSubject();

    await subject.processor.handlePage({
      data: { runItemId: 'item-id' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as never);

    expect(subject.urlService.assertPublicUrl).toHaveBeenCalledWith(
      'https://external.example/page',
    );
    expect(subject.renderer.render).toHaveBeenCalledWith(
      'https://external.example/page',
    );
    expect(subject.indexing.index).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: 'site-id',
        sourceUrl: 'https://external.example/page',
        canonicalUrl: null,
      }),
      null,
    );
    expect(subject.itemRepository.update).toHaveBeenCalledWith(
      'item-id',
      expect.objectContaining({ status: CrawlRunItemStatus.INDEXED }),
    );
  });

  it('forces URL re-index when content and cache validators are unchanged', async () => {
    const subject = createSubject(CrawlRunTrigger.RECRAWL_PAGE);
    const existing = {
      id: 'document-id',
      contentHash: 'hash',
      etag: 'same-etag',
      lastModified: null,
      canonicalUrl: null,
      normalizedUrl: 'https://external.example/page',
    };
    subject.indexing.findExisting.mockResolvedValue(existing);

    await subject.processor.handlePage({
      data: { runItemId: 'item-id' },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as never);

    expect(subject.http.isNotModified).not.toHaveBeenCalled();
    expect(subject.renderer.render).toHaveBeenCalled();
    expect(subject.indexing.index).toHaveBeenCalledWith(
      expect.objectContaining({ contentHash: 'hash' }),
      existing,
    );
    expect(subject.documentRepository.update).toHaveBeenCalledWith(
      'document-id',
      expect.objectContaining({ reindexStatus: 'idle', reindexError: null }),
    );
  });

  it('cleans up previous items and queues page jobs with removeOnFail: false in handleSitemap', async () => {
    const subject = createSubject(CrawlRunTrigger.MANUAL_SITEMAP);

    await subject.processor.handleSitemap({
      data: { runId: 'run-id' },
    } as never);

    expect(subject.itemRepository.delete).toHaveBeenCalledWith({
      runId: 'run-id',
    });
    expect(subject.queue.addBulk).toHaveBeenCalledWith([
      {
        name: 'crawl-page',
        data: { runItemId: 'item-0' },
        opts: expect.objectContaining({
          jobId: 'item-0',
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
        }) as unknown,
      },
    ]);
  });
});
