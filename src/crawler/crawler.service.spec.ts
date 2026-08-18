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
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: 'run-id', ...value }),
      ),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const itemRepository = {
      create: jest.fn((value: Record<string, unknown>) => value),
      save: jest.fn((value: Record<string, unknown>) =>
        Promise.resolve({ id: 'item-id', ...value }),
      ),
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
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
      expect.objectContaining({ jobId: 'item-id' }),
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
      expect.objectContaining({ jobId: 'sitemap-run-id' }),
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
});
