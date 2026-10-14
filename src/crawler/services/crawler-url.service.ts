import { BadRequestException, Injectable } from '@nestjs/common';
import * as ipaddr from 'ipaddr.js';
import { lookup } from 'node:dns/promises';

@Injectable()
export class CrawlerUrlService {
  normalize(rawUrl: string): string {
    const url = this.parse(rawUrl);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid$|gclid$)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  }

  async assertPublicUrl(rawUrl: string): Promise<URL> {
    const url = this.parse(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new BadRequestException(
        'Only HTTP and HTTPS crawler URLs are allowed',
      );
    }
    if (url.username || url.password) {
      throw new BadRequestException(
        'Crawler URLs must not include credentials',
      );
    }
    if (url.port && !['80', '443'].includes(url.port)) {
      throw new BadRequestException(
        'Crawler URLs may only use ports 80 and 443',
      );
    }

    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new BadRequestException('Crawler hostname did not resolve');
    }
    if (addresses.some(({ address }) => !this.isPublicAddress(address))) {
      throw new BadRequestException(
        'Crawler URL resolves to a private or reserved network address',
      );
    }
    return url;
  }

  isPublicAddress(address: string): boolean {
    if (!ipaddr.isValid(address)) return false;
    const parsed = ipaddr.parse(address);
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().range() === 'unicast';
    }
    return parsed.range() === 'unicast';
  }

  private parse(rawUrl: string): URL {
    try {
      return new URL(rawUrl.trim());
    } catch {
      throw new BadRequestException('Invalid crawler URL');
    }
  }
}
