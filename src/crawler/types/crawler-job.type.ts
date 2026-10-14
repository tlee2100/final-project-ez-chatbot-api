export type CrawlSitemapJobData = {
  runId: string;
};

export type CrawlPageJobData = {
  runItemId: string;
};

export type ScheduledCrawlJobData = {
  crawlerConfigId: string;
};

export type DiscoveredSitemapUrl = {
  url: string;
  normalizedUrl: string;
  lastModified: Date | null;
};
