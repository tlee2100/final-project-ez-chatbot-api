import { gzipSync } from 'node:zlib';
import type { CrawlerHttpService } from './crawler-http.service';
import { CrawlerUrlService } from './crawler-url.service';
import { SitemapService } from './sitemap.service';

describe('SitemapService', () => {
  let urlService: CrawlerUrlService;

  beforeEach(() => {
    urlService = new CrawlerUrlService();
    jest
      .spyOn(urlService, 'assertPublicUrl')
      .mockImplementation((url) => Promise.resolve(new URL(url)));
  });

  it('reads cross-host sitemap indexes, deduplicates URLs, and avoids cycles', async () => {
    const responses: Record<string, Buffer> = {
      'https://example.com/sitemap.xml': Buffer.from(
        '<sitemapindex><sitemap><loc>https://maps.example.net/child.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap.xml</loc></sitemap></sitemapindex>',
      ),
      'https://maps.example.net/child.xml': Buffer.from(
        '<urlset><url><loc>https://example.com/help</loc><lastmod>2026-08-01</lastmod></url><url><loc>https://example.com/help#top</loc></url><url><loc>https://other.example.net/included</loc></url><url><loc>file:///etc/passwd</loc></url></urlset>',
      ),
    };
    const fetchBuffer = jest.fn((url: string) =>
      Promise.resolve({
        status: 200,
        finalUrl: url,
        headers: {},
        data: responses[url],
      }),
    );
    const http = { fetchBuffer } as unknown as CrawlerHttpService;
    const service = new SitemapService(http, urlService);

    const result = await service.discover('https://example.com/sitemap.xml');

    expect(result).toHaveLength(2);
    expect(result[0].normalizedUrl).toBe('https://example.com/help');
    expect(result[0].lastModified?.toISOString()).toContain('2026-08-01');
    expect(result[1].normalizedUrl).toBe('https://other.example.net/included');
    expect(fetchBuffer).toHaveBeenCalledWith(
      'https://example.com/sitemap.xml',
      'example.com',
      expect.any(Number),
    );
    expect(fetchBuffer).toHaveBeenCalledWith(
      'https://maps.example.net/child.xml',
      'maps.example.net',
      expect.any(Number),
    );
  });

  it('supports gzip-compressed sitemap files', async () => {
    const http = {
      fetchBuffer: jest.fn((url: string) =>
        Promise.resolve({
          status: 200,
          finalUrl: url,
          headers: { 'content-type': 'application/gzip' },
          data: gzipSync(
            '<urlset><url><loc>https://example.com/from-gzip</loc></url></urlset>',
          ),
        }),
      ),
    } as unknown as CrawlerHttpService;
    const service = new SitemapService(http, urlService);

    await expect(
      service.discover('https://example.com/sitemap.xml.gz'),
    ).resolves.toEqual([
      expect.objectContaining({
        normalizedUrl: 'https://example.com/from-gzip',
      }),
    ]);
  });
});
