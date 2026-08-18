export class CrawlerQuotaExceededError extends Error {
  constructor() {
    super('Knowledge base vector quota would be exceeded');
    this.name = 'CrawlerQuotaExceededError';
  }
}

export class CrawlerHttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`Crawler page request failed with HTTP ${status}`);
    this.name = 'CrawlerHttpStatusError';
  }
}
