import { Injectable } from '@nestjs/common';
import { CRAWLER_HOST_DELAY_MS } from '../constants/crawler.constants';

@Injectable()
export class HostLockService {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(
    hostname: string,
    crawlDelayMs: number,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(hostname) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(hostname, tail);
    await previous;
    try {
      return await action();
    } finally {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(CRAWLER_HOST_DELAY_MS, crawlDelayMs)),
      );
      release();
      if (this.tails.get(hostname) === tail) this.tails.delete(hostname);
    }
  }
}
