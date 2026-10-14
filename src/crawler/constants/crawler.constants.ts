export const CRAWLER_QUEUE = 'crawler-processing';
export const CRAWL_SITEMAP_JOB = 'crawl-sitemap';
export const CRAWL_PAGE_JOB = 'crawl-page';
export const SCHEDULED_CRAWL_JOB = 'scheduled-crawl';

export const CRAWLER_INTERVAL_DAYS = 7;
export const CRAWLER_INTERVAL_MS = CRAWLER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
export const CRAWLER_USER_AGENT =
  process.env.CRAWLER_USER_AGENT?.trim() || 'EzChatbotCrawler/1.0';
export const CRAWLER_NAVIGATION_TIMEOUT_MS = 30_000;
export const CRAWLER_HOST_DELAY_MS = 1_000;
export const CRAWLER_MAX_REDIRECTS = 5;
export const CRAWLER_MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
export const CRAWLER_MAX_URLS_PER_SITEMAP = 50_000;
export const CRAWLER_MIN_CONTENT_LENGTH = 50;
export const CRAWLER_BROWSER_CONNECT_TIMEOUT_MS = 15_000;
