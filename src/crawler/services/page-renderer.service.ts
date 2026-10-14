import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Browser, BrowserContext, HTTPResponse } from 'puppeteer-core';
import {
  CRAWLER_BROWSER_CONNECT_TIMEOUT_MS,
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
export class PageRendererService {
  private readonly logger = new Logger(PageRendererService.name);
  private readonly safeHostCache = new Map<string, number>();

  constructor(private readonly urlService: CrawlerUrlService) {}

  async render(rawUrl: string): Promise<RenderedPage> {
    const target = await this.urlService.assertPublicUrl(rawUrl);
    const browser = await this.connectBrowser();
    let context: BrowserContext | undefined;
    try {
      context = await browser.createBrowserContext();
      const page = await context.newPage();
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
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async connectBrowser(): Promise<Browser> {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
    const browserWSEndpoint = process.env.BROWSER_WS_ENDPOINT?.trim();

    if (!browserWSEndpoint && !executablePath) {
      throw new ServiceUnavailableException(
        'BROWSER_WS_ENDPOINT or PUPPETEER_EXECUTABLE_PATH is required for crawler rendering',
      );
    }

    const { default: puppeteer } = await import('puppeteer-core');

    if (executablePath) {
      try {
        const noSandbox = process.env.CRAWLER_CHROMIUM_NO_SANDBOX === 'true';
        return await puppeteer.launch({
          executablePath,
          headless: true,
          args: [
            '--disable-dev-shm-usage',
            ...(noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
          ],
        });
      } catch (error) {
        const detail = this.extractErrorMessage(error);
        this.logger.error(`Local browser launch failed: ${detail}`);
        if (!browserWSEndpoint) {
          throw new ServiceUnavailableException(
            `Browser rendering service is unavailable: ${detail}`,
          );
        }
      }
    }

    if (browserWSEndpoint) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const connectPromise = puppeteer.connect({ browserWSEndpoint });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Browser WebSocket connection timeout (15s)'));
          }, CRAWLER_BROWSER_CONNECT_TIMEOUT_MS);
        });
        return await Promise.race([connectPromise, timeoutPromise]);
      } catch (error) {
        const detail = this.extractErrorMessage(error);
        this.logger.error(`Browser connection failed: ${detail}`);
        throw new ServiceUnavailableException(
          `Browser rendering service is unavailable: ${detail}`,
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw new ServiceUnavailableException(
      'Browser rendering service is unavailable',
    );
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error !== null) {
      const record = error as Record<string | symbol, unknown>;
      if (typeof record.message === 'string') return record.message;
      if (
        record.error &&
        typeof record.error === 'object' &&
        typeof (record.error as Record<string, unknown>).message === 'string'
      ) {
        return (record.error as Record<string, unknown>).message as string;
      }
      for (const sym of Object.getOwnPropertySymbols(record)) {
        const val = record[sym];
        if (typeof val === 'string') return val;
        if (
          val &&
          typeof val === 'object' &&
          typeof (val as Record<string, unknown>).message === 'string'
        ) {
          return (val as Record<string, unknown>).message as string;
        }
      }
      try {
        return JSON.stringify(error);
      } catch {
        return 'Unknown browser error';
      }
    }
    return typeof error === 'string' ? error : 'Unknown browser error';
  }

  private async assertCachedPublicUrl(rawUrl: string): Promise<void> {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    const expiresAt = this.safeHostCache.get(hostname) ?? 0;
    if (expiresAt > Date.now()) return;
    await this.urlService.assertPublicUrl(rawUrl);
    this.safeHostCache.set(hostname, Date.now() + 5 * 60 * 1000);
  }
}
