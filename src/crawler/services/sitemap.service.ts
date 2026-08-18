import { BadRequestException, Injectable } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';
import { gunzipSync } from 'node:zlib';
import {
  CRAWLER_MAX_SITEMAP_BYTES,
  CRAWLER_MAX_URLS_PER_SITEMAP,
} from '../constants/crawler.constants';
import type { DiscoveredSitemapUrl } from '../types/crawler-job.type';
import { CrawlerHttpService } from './crawler-http.service';
import { CrawlerUrlService } from './crawler-url.service';

type SitemapEntry = { loc?: string; lastmod?: string };

@Injectable()
export class SitemapService {
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true,
    processEntities: false,
  });

  constructor(
    private readonly http: CrawlerHttpService,
    private readonly urlService: CrawlerUrlService,
  ) {}

  async discover(sitemapUrl: string) {
    await this.urlService.assertPublicUrl(sitemapUrl);
    const visitedSitemaps = new Set<string>();
    const discovered = new Map<string, DiscoveredSitemapUrl>();
    await this.readSitemap(sitemapUrl, visitedSitemaps, discovered, 0);
    return [...discovered.values()];
  }

  private async readSitemap(
    sitemapUrl: string,
    visited: Set<string>,
    discovered: Map<string, DiscoveredSitemapUrl>,
    depth: number,
  ): Promise<void> {
    if (depth > 10) {
      throw new BadRequestException('Sitemap index nesting is too deep');
    }
    const normalizedSitemap = this.urlService.normalize(sitemapUrl);
    if (visited.has(normalizedSitemap)) return;
    visited.add(normalizedSitemap);

    const response = await this.http.fetchBuffer(
      sitemapUrl,
      new URL(sitemapUrl).hostname,
      CRAWLER_MAX_SITEMAP_BYTES,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new BadRequestException(
        `Sitemap request failed with HTTP ${response.status}`,
      );
    }
    const contentType = response.headers['content-type'];
    const isGzip =
      sitemapUrl.toLowerCase().endsWith('.gz') ||
      (typeof contentType === 'string' && contentType.includes('gzip'));
    const xmlBuffer = isGzip
      ? gunzipSync(response.data, {
          maxOutputLength: CRAWLER_MAX_SITEMAP_BYTES,
        })
      : response.data;
    if (xmlBuffer.byteLength > CRAWLER_MAX_SITEMAP_BYTES) {
      throw new BadRequestException('Uncompressed sitemap exceeds 50 MB');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = this.parser.parse(xmlBuffer.toString('utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new BadRequestException('Sitemap XML is malformed');
    }

    const urlset = parsed.urlset as { url?: SitemapEntry | SitemapEntry[] };
    if (urlset?.url) {
      const entries = this.asArray(urlset.url);
      if (entries.length > CRAWLER_MAX_URLS_PER_SITEMAP) {
        throw new BadRequestException('Sitemap contains more than 50,000 URLs');
      }
      for (const entry of entries) {
        if (!entry.loc) continue;
        try {
          const target = new URL(entry.loc);
          if (!['http:', 'https:'].includes(target.protocol)) continue;
          const normalizedUrl = this.urlService.normalize(target.toString());
          const existing = discovered.get(normalizedUrl);
          const lastModified = this.parseDate(entry.lastmod);
          if (!existing || (!existing.lastModified && lastModified)) {
            discovered.set(normalizedUrl, {
              url: target.toString(),
              normalizedUrl,
              lastModified,
            });
          }
        } catch {
          continue;
        }
      }
      return;
    }

    const index = parsed.sitemapindex as {
      sitemap?: SitemapEntry | SitemapEntry[];
    };
    if (index?.sitemap) {
      const entries = this.asArray(index.sitemap);
      if (entries.length > CRAWLER_MAX_URLS_PER_SITEMAP) {
        throw new BadRequestException(
          'Sitemap index contains more than 50,000 entries',
        );
      }
      for (const entry of entries) {
        if (!entry.loc) continue;
        let child: URL;
        try {
          child = new URL(entry.loc, sitemapUrl);
        } catch {
          continue;
        }
        if (!['http:', 'https:'].includes(child.protocol)) continue;
        await this.readSitemap(
          child.toString(),
          visited,
          discovered,
          depth + 1,
        );
      }
      return;
    }
    throw new BadRequestException('XML is not a supported sitemap document');
  }

  private asArray<T>(value: T | T[]): T[] {
    return Array.isArray(value) ? value : [value];
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
