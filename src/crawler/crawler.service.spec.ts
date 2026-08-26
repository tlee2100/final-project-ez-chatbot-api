jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));
jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { CrawlRun } from './entities/crawl-run.entity';
import {
  CrawlRunItemStatus,
  CrawlRunStatus,
  CrawlRunTrigger,
} from './enums/crawler.enums';
import { CrawlerUrlService } from './services/crawler-url.service';

describe('CrawlerService external sources', () => {
  const siteId = 'site-id';
  const user = { id: 'user-id' };

  function createSubject() {
    const configRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: 'config-id', ...value }),
      ),
    };
    const runRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: 'run-id', ...value }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const itemRepository = {
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: 'item-id', ...value }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
      getRepeatableJobs: jest.fn().mockResolvedValue([]),
      removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
    };
    const dataSource = {
      transaction: jest.fn(
        async (
          callback: (manager: {
            getRepository: (entity: unknown) => unknown;
          }) => Promise<unknown>,
        ) =>
          callback({
            getRepository: (entity: unknown) =>
              entity === CrawlRun ? runRepository : itemRepository,
          }),
      ),
    };
    const siteService = {
      assertSiteAccess: jest.fn().mockResolvedValue({
        id: siteId,
        url: 'https://primary.example.com',
      }),
    };
    const urlService = new CrawlerUrlService();
    const assertPublicUrl = jest
      .spyOn(urlService, 'assertPublicUrl')
      .mockImplementation((url) => Promise.resolve(new URL(url)));

    const service = new CrawlerService(
      configRepository as never,
      runRepository as never,
      itemRepository as never,
      dataSource as never,
      {} as never,
      queue as never,
      siteService as never,
      {} as never,
      urlService,
    );

    return {
      service,
      configRepository,
      runRepository,
      itemRepository,
      queue,
      dataSource,
      siteService,
      urlService,
      assertPublicUrl,
    };
  }

  it('saves an external sitemap without comparing it to the site URL', async () => {
    const subject = createSubject();
    subject.configRepository.findOne.mockResolvedValue(null);

    await subject.service.updateConfig(
      siteId,
      {
        sitemapUrl: 'https://docs.vendor.example/sitemap.xml',
        autoSyncEnabled: false,
      },
      user as never,
    );

    expect(subject.siteService.assertSiteAccess).toHaveBeenCalledWith(
      siteId,
      user,
    );
    expect(subject.assertPublicUrl).toHaveBeenCalledWith(
      'https://docs.vendor.example/sitemap.xml',
    );
    expect(subject.configRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId,
        sitemapUrl: 'https://docs.vendor.example/sitemap.xml',
      }),
    );
  });

  it('queues an external manual URL for the authenticated site', async () => {
    const subject = createSubject();

    const result = await subject.service.startManualUrl(
      siteId,
      'https://knowledge.partner.example/article',
      user as never,
    );

    expect(result).toEqual({
      runId: 'run-id',
      status: CrawlRunStatus.PROCESSING,
    });
    expect(subject.itemRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://knowledge.partner.example/article',
        status: CrawlRunItemStatus.QUEUED,
      }),
    );
    expect(subject.queue.add).toHaveBeenCalledWith(
      'crawl-page',
      { runItemId: 'item-id' },
      expect.objectContaining({
        jobId: 'item-id',
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      }),
    );
  });

  it('stores a manual URL as waiting while another crawl is active', async () => {
    const subject = createSubject();
    subject.runRepository.findOne.mockResolvedValue({
      id: 'active-run',
      siteId,
      status: CrawlRunStatus.PROCESSING,
    });

    const result = await subject.service.startManualUrl(
      siteId,
      'https://knowledge.partner.example/waiting',
      user as never,
    );

    expect(result).toEqual({
      runId: 'run-id',
      status: CrawlRunStatus.WAITING,
    });
    expect(subject.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(subject.runRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: CrawlRunTrigger.MANUAL_URL,
        status: CrawlRunStatus.WAITING,
        totalPages: 1,
      }),
    );
    expect(subject.itemRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://knowledge.partner.example/waiting',
        status: CrawlRunItemStatus.QUEUED,
      }),
    );
    expect(subject.queue.add).not.toHaveBeenCalled();
  });

  it('keeps URL recrawls conflicting while another crawl is active', async () => {
    const subject = createSubject();
    subject.runRepository.findOne.mockResolvedValue({
      id: 'active-run',
      siteId,
      status: CrawlRunStatus.PROCESSING,
    });

    await expect(
      subject.service.startManualUrl(
        siteId,
        'https://knowledge.partner.example/existing',
        user as never,
        CrawlRunTrigger.RECRAWL_PAGE,
      ),
    ).rejects.toThrow(ConflictException);

    expect(subject.dataSource.transaction).not.toHaveBeenCalled();
    expect(subject.queue.add).not.toHaveBeenCalled();
  });

  it('claims and enqueues the oldest waiting URL when the site is idle', async () => {
    const subject = createSubject();
    subject.runRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'waiting-run',
        siteId,
        status: CrawlRunStatus.WAITING,
        createdAt: new Date('2026-08-26T00:00:00Z'),
      });
    subject.itemRepository.find.mockResolvedValue([
      {
        id: 'waiting-item',
        runId: 'waiting-run',
        status: CrawlRunItemStatus.QUEUED,
        createdAt: new Date('2026-08-26T00:00:00Z'),
      },
    ]);

    const startedRunId = await subject.service.startNextWaitingRun(siteId);

    expect(startedRunId).toBe('waiting-run');
    expect(subject.runRepository.findOne).toHaveBeenLastCalledWith({
      where: { siteId, status: CrawlRunStatus.WAITING },
      order: { createdAt: 'ASC' },
    });
    expect(subject.runRepository.update).toHaveBeenCalledWith(
      { id: 'waiting-run', status: CrawlRunStatus.WAITING },
      expect.objectContaining({ status: CrawlRunStatus.PROCESSING }),
    );
    expect(subject.queue.add).toHaveBeenCalledWith(
      'crawl-page',
      { runItemId: 'waiting-item' },
      expect.objectContaining({ jobId: 'waiting-item' }),
    );
  });

  it('does not enqueue when another dispatcher already claimed the waiting run', async () => {
    const subject = createSubject();
    subject.runRepository.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'waiting-run',
        siteId,
        status: CrawlRunStatus.WAITING,
      });
    subject.runRepository.update.mockResolvedValueOnce({ affected: 0 });

    const startedRunId = await subject.service.startNextWaitingRun(siteId);

    expect(startedRunId).toBeNull();
    expect(subject.itemRepository.find).not.toHaveBeenCalled();
    expect(subject.queue.add).not.toHaveBeenCalled();
  });

  it('starts a configured external sitemap crawl', async () => {
    const subject = createSubject();
    subject.configRepository.findOne.mockResolvedValue({
      id: 'config-id',
      siteId,
      sitemapUrl: 'https://docs.vendor.example/sitemap.xml',
      autoSyncEnabled: false,
    });

    const result = await subject.service.startSitemap(siteId, user as never);

    expect(result).toEqual({
      runId: 'run-id',
      status: CrawlRunStatus.QUEUED,
    });
    expect(subject.assertPublicUrl).toHaveBeenCalledWith(
      'https://docs.vendor.example/sitemap.xml',
    );
    expect(subject.queue.add).toHaveBeenCalledWith(
      'crawl-sitemap',
      { runId: 'run-id' },
      expect.objectContaining({
        jobId: 'sitemap-run-id',
        removeOnFail: { count: 200, age: 7 * 24 * 3600 },
      }),
    );
  });

  it('rejects a non-public URL before creating a crawl run', async () => {
    const subject = createSubject();
    subject.assertPublicUrl.mockRejectedValueOnce(
      new BadRequestException('private address'),
    );

    await expect(
      subject.service.startManualUrl(
        siteId,
        'http://127.0.0.1/internal',
        user as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(subject.runRepository.save).not.toHaveBeenCalled();
    expect(subject.queue.add).not.toHaveBeenCalled();
  });

  describe('recoverOrphanedRuns', () => {
    it('re-enqueues sitemap job when run is in DISCOVERING and job is missing from queue', async () => {
      const subject = createSubject();
      subject.runRepository.find.mockResolvedValueOnce([
        {
          id: 'run-1',
          status: CrawlRunStatus.DISCOVERING,
          trigger: 'manual_sitemap',
          totalPages: 0,
        },
      ]);
      subject.queue.getJob.mockResolvedValue(null);

      await subject.service.recoverOrphanedRuns();

      expect(subject.queue.add).toHaveBeenCalledWith(
        'crawl-sitemap',
        { runId: 'run-1' },
        expect.objectContaining({
          jobId: 'sitemap-run-1',
          removeOnFail: { count: 200, age: 7 * 24 * 3600 },
        }),
      );
    });

    it('re-enqueues pending page items when run is in PROCESSING and jobs are missing', async () => {
      const subject = createSubject();
      subject.runRepository.find.mockResolvedValueOnce([
        {
          id: 'run-2',
          status: CrawlRunStatus.PROCESSING,
          trigger: 'manual_sitemap',
          totalPages: 2,
        },
      ]);
      subject.itemRepository.find.mockResolvedValue([
        { id: 'item-1', runId: 'run-2', status: CrawlRunItemStatus.RENDERING },
        { id: 'item-2', runId: 'run-2', status: CrawlRunItemStatus.QUEUED },
      ]);
      subject.queue.getJob.mockResolvedValue(null);

      await subject.service.recoverOrphanedRuns();

      expect(subject.itemRepository.update).toHaveBeenCalledWith('item-1', {
        status: CrawlRunItemStatus.QUEUED,
      });
      expect(subject.queue.add).toHaveBeenCalledWith(
        'crawl-page',
        { runItemId: 'item-1' },
        expect.objectContaining({
          jobId: 'item-1',
          removeOnFail: { count: 200, age: 7 * 24 * 3600 },
        }),
      );
      expect(subject.queue.add).toHaveBeenCalledWith(
        'crawl-page',
        { runItemId: 'item-2' },
        expect.objectContaining({
          jobId: 'item-2',
          removeOnFail: { count: 200, age: 7 * 24 * 3600 },
        }),
      );
    });

    it('does not re-enqueue when jobs are already active or waiting in queue', async () => {
      const subject = createSubject();
      subject.runRepository.find.mockResolvedValueOnce([
        {
          id: 'run-3',
          status: CrawlRunStatus.PROCESSING,
          trigger: 'manual_url',
          totalPages: 1,
        },
      ]);
      subject.itemRepository.find.mockResolvedValue([
        {
          id: 'item-active',
          runId: 'run-3',
          status: CrawlRunItemStatus.RENDERING,
        },
      ]);
      const mockJob = {
        isFailed: jest.fn().mockResolvedValue(false),
        isCompleted: jest.fn().mockResolvedValue(false),
      };
      subject.queue.getJob.mockResolvedValue(mockJob);

      await subject.service.recoverOrphanedRuns();

      expect(subject.queue.add).not.toHaveBeenCalled();
    });

    it('starts a waiting URL during recovery when the site has no active run', async () => {
      const subject = createSubject();
      subject.runRepository.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'waiting-run',
            siteId,
            status: CrawlRunStatus.WAITING,
          },
        ]);
      subject.runRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'waiting-run',
          siteId,
          status: CrawlRunStatus.WAITING,
        });
      subject.itemRepository.find.mockResolvedValue([
        {
          id: 'waiting-item',
          runId: 'waiting-run',
          status: CrawlRunItemStatus.QUEUED,
        },
      ]);

      await subject.service.recoverOrphanedRuns();

      expect(subject.queue.add).toHaveBeenCalledWith(
        'crawl-page',
        { runItemId: 'waiting-item' },
        expect.objectContaining({ jobId: 'waiting-item' }),
      );
    });
  });
});
