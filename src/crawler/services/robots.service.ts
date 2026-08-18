import { Injectable } from '@nestjs/common';
import robotsParser from 'robots-parser';
import { CRAWLER_USER_AGENT } from '../constants/crawler.constants';
import { CrawlerHttpService } from './crawler-http.service';

type CachedRobots = {
  expiresAt: number;
  robot: ReturnType<typeof robotsParser>;
};

@Injectable()
export class RobotsService {
  private readonly cache = new Map<string, CachedRobots>();

  constructor(private readonly http: CrawlerHttpService) {}

  async getForUrl(rawUrl: string) {
    const target = new URL(rawUrl);
    const origin = target.origin;
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > Date.now()) return cached.robot;

    const robotsUrl = `${origin}/robots.txt`;
    let body = '';
    try {
      const response = await this.http.fetchBuffer(
        robotsUrl,
        target.hostname,
        512 * 1024,
      );
      if (response.status >= 500) {
        body = 'User-agent: *\nDisallow: /';
      } else if (response.status >= 200 && response.status < 300) {
        body = response.data.toString('utf8');
      }
    } catch {
      body = 'User-agent: *\nDisallow: /';
    }
    const robot = robotsParser(robotsUrl, body);
    this.cache.set(origin, {
      robot,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return robot;
  }

  async isAllowed(rawUrl: string): Promise<boolean> {
    const robot = await this.getForUrl(rawUrl);
    return robot.isAllowed(rawUrl, CRAWLER_USER_AGENT) !== false;
  }

  async crawlDelayMs(rawUrl: string): Promise<number> {
    const robot = await this.getForUrl(rawUrl);
    return Math.max(0, (robot.getCrawlDelay(CRAWLER_USER_AGENT) ?? 0) * 1000);
  }
}
