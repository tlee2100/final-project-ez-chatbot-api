import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Browser, HTTPResponse } from 'puppeteer-core';
import {
  CRAWLER_NAVIGATION_TIMEOUT_MS,
  CRAWLER_USER_AGENT,
} from '../constants/crawler.constants';
import { CrawlerUrlService } from './crawler-url.service';

export type RenderedPage = {
  html: string;
  finalUrl: string;
  httpStatus: number;
  etag: string | null;
  lastModified: Date | null;
};

@Injectable()
export class PageRendererService implements OnModuleDestroy {
  private browserPromise?: Promise<Browser>;
  private readonly safeHostCache = new Map<string, number>();

  constructor(private readonly urlService: CrawlerUrlService) {}

  async render(rawUrl: string): Promise<RenderedPage> {
    const target = await this.urlService.assertPublicUrl(rawUrl);
    const browser = await this.getBrowser();
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    try {
      await page.setUserAgent(CRAWLER_USER_AGENT);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        void (async () => {
          try {
            const resourceType = request.resourceType();
            if (['image', 'media', 'font'].includes(resourceType)) {
              await request.abort();
              return;
            }
            const requestUrl = request.url();
            if (
              /(?:google-analytics|googletagmanager|doubleclick|facebook\.com\/tr|hotjar|segment\.io)/i.test(
                requestUrl,
              )
            ) {
              await request.abort();
              return;
            }
            if (
              requestUrl.startsWith('data:') ||
              requestUrl.startsWith('blob:')
            ) {
              await request.continue();
              return;
            }
            const parsed = new URL(requestUrl);
            if (
              request.isNavigationRequest() &&
              request.frame() === page.mainFrame() &&
              (parsed.hostname.toLowerCase() !==
                target.hostname.toLowerCase() ||
                (target.protocol === 'https:' && parsed.protocol !== 'https:'))
            ) {
              await request.abort();
              return;
            }
            await this.assertCachedPublicUrl(requestUrl);
            await request.continue();
          } catch {
            try {
              await request.abort();
            } catch {
              // The request may already be resolved while the browser closes.
            }
          }
        })();
      });
      const response: HTTPResponse | null = await page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: CRAWLER_NAVIGATION_TIMEOUT_MS,
      });
      if (!response) {
        throw new ServiceUnavailableException(
          'Browser navigation returned no response',
        );
      }
      await page
        .waitForNetworkIdle({ idleTime: 500, timeout: 3_000 })
        .catch(() => undefined);
      const finalUrl = page.url();
      const finalTarget = await this.urlService.assertPublicUrl(finalUrl);
      if (
        finalTarget.hostname.toLowerCase() !== target.hostname.toLowerCase()
      ) {
        throw new ServiceUnavailableException(
          'Crawler navigation left the configured hostname',
        );
      }
      if (target.protocol === 'https:' && finalTarget.protocol !== 'https:') {
        throw new ServiceUnavailableException(
          'Crawler navigation downgraded HTTPS to HTTP',
        );
      }
      const headers = response.headers();
      const lastModified = headers['last-modified']
        ? new Date(headers['last-modified'])
        : null;
      return {
        html: await page.content(),
        finalUrl,
        httpStatus: response.status(),
        etag: headers.etag ?? null,
        lastModified:
          lastModified && !Number.isNaN(lastModified.getTime())
            ? lastModified
            : null,
      };
    } finally {
      await context.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browserPromise) {
      const browser = await this.browserPromise.catch(() => undefined);
      await browser?.close();
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
      if (!executablePath) {
        throw new ServiceUnavailableException(
          'PUPPETEER_EXECUTABLE_PATH is required for crawler rendering',
        );
      }
      const noSandbox = process.env.CRAWLER_CHROMIUM_NO_SANDBOX === 'true';
      const { default: puppeteer } = await import('puppeteer-core');
      this.browserPromise = puppeteer.launch({
        executablePath,
        headless: true,
        args: [
          '--disable-dev-shm-usage',
          ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ],
      });
      this.browserPromise
        .then((browser) => {
          browser.once('disconnected', () => {
            this.browserPromise = undefined;
          });
        })
        .catch(() => {
          this.browserPromise = undefined;
        });
    }
    return this.browserPromise;
  }

  private async assertCachedPublicUrl(rawUrl: string): Promise<void> {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const expiresAt = this.safeHostCache.get(hostname) ?? 0;
    if (expiresAt > Date.now()) return;
    await this.urlService.assertPublicUrl(rawUrl);
    this.safeHostCache.set(hostname, Date.now() + 5 * 60 * 1000);
  }
}
