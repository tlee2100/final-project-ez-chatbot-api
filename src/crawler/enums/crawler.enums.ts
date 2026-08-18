export enum DocumentSourceKind {
  FILE = 'file',
  URL = 'url',
}

export enum CrawlRunTrigger {
  MANUAL_SITEMAP = 'manual_sitemap',
  SCHEDULED = 'scheduled',
  MANUAL_URL = 'manual_url',
  RETRY_FAILED = 'retry_failed',
  RECRAWL_PAGE = 'recrawl_page',
}

export enum CrawlRunStatus {
  QUEUED = 'queued',
  DISCOVERING = 'discovering',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  PARTIAL_FAILED = 'partial_failed',
  FAILED = 'failed',
}

export enum CrawlRunItemStatus {
  DISCOVERED = 'discovered',
  QUEUED = 'queued',
  RENDERING = 'rendering',
  INDEXED = 'indexed',
  UNCHANGED = 'unchanged',
  SKIPPED_ROBOTS = 'skipped_robots',
  SKIPPED_NOINDEX = 'skipped_noindex',
  FAILED = 'failed',
  QUOTA_EXCEEDED = 'quota_exceeded',
  RETIRED = 'retired',
}

export const ACTIVE_CRAWL_RUN_STATUSES = [
  CrawlRunStatus.QUEUED,
  CrawlRunStatus.DISCOVERING,
  CrawlRunStatus.PROCESSING,
];

export const TERMINAL_CRAWL_ITEM_STATUSES = [
  CrawlRunItemStatus.INDEXED,
  CrawlRunItemStatus.UNCHANGED,
  CrawlRunItemStatus.SKIPPED_ROBOTS,
  CrawlRunItemStatus.SKIPPED_NOINDEX,
  CrawlRunItemStatus.FAILED,
  CrawlRunItemStatus.QUOTA_EXCEEDED,
  CrawlRunItemStatus.RETIRED,
];
