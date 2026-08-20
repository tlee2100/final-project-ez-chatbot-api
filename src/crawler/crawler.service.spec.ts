jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));
jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));

import { BadRequestException } from '@nestjs/common';
import { CrawlerService } from './crawler.service';
import { CrawlRunItemStatus, CrawlRunStatus } from './enums/crawler.enums';
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
      update: jest.fn().mockResolvedValue(undefined),
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
      expect.objectContaining({ jobId: 'item-id', removeOnFail: false }),
    );
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
      expect.objectContaining({ jobId: 'sitemap-run-id', removeOnFail: false }),
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
      subject.runRepository.find.mockResolvedValue([
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
          removeOnFail: false,
        }),
      );
    });

    it('re-enqueues pending page items when run is in PROCESSING and jobs are missing', async () => {
      const subject = createSubject();
      subject.runRepository.find.mockResolvedValue([
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
        expect.objectContaining({ jobId: 'item-1', removeOnFail: false }),
      );
      expect(subject.queue.add).toHaveBeenCalledWith(
        'crawl-page',
        { runItemId: 'item-2' },
        expect.objectContaining({ jobId: 'item-2', removeOnFail: false }),
      );
    });

    it('does not re-enqueue when jobs are already active or waiting in queue', async () => {
      const subject = createSubject();
      subject.runRepository.find.mockResolvedValue([
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
  });
});
