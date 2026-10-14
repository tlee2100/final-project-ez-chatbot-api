import { BadRequestException, Injectable } from '@nestjs/common';
import axios, { type AxiosResponse } from 'axios';
import {
  CRAWLER_MAX_REDIRECTS,
  CRAWLER_USER_AGENT,
} from '../constants/crawler.constants';
import { CrawlerUrlService } from './crawler-url.service';

export type SecureHttpResponse = {
  status: number;
  finalUrl: string;
  headers: Record<string, unknown>;
  data: Buffer;
};

@Injectable()
export class CrawlerHttpService {
  constructor(private readonly urlService: CrawlerUrlService) {}

  async fetchBuffer(
    rawUrl: string,
    expectedHostname: string,
    maxBytes: number,
    headers: Record<string, string> = {},
  ): Promise<SecureHttpResponse> {
    let currentUrl = rawUrl;
    const initialProtocol = new URL(rawUrl).protocol;
    for (let redirect = 0; redirect <= CRAWLER_MAX_REDIRECTS; redirect += 1) {
      const parsed = await this.urlService.assertPublicUrl(currentUrl);
      if (parsed.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
        throw new BadRequestException(
          'Crawler redirect left the configured hostname',
        );
      }
      if (initialProtocol === 'https:' && parsed.protocol !== 'https:') {
        throw new BadRequestException(
          'Crawler redirect downgraded HTTPS to HTTP',
        );
      }
      const response: AxiosResponse<ArrayBuffer> = await axios.get(currentUrl, {
        responseType: 'arraybuffer',
        maxRedirects: 0,
        timeout: 30_000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        headers: { 'User-Agent': CRAWLER_USER_AGENT, ...headers },
        validateStatus: () => true,
      });
      if (response.status >= 300 && response.status < 400) {
        const location: unknown = response.headers.location;
        if (
          typeof location !== 'string' ||
          !location ||
          redirect === CRAWLER_MAX_REDIRECTS
        ) {
          throw new BadRequestException('Crawler redirect limit exceeded');
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      const data = Buffer.from(response.data);
      if (data.byteLength > maxBytes) {
        throw new BadRequestException('Crawler response exceeds size limit');
      }
      return {
        status: response.status,
        finalUrl: currentUrl,
        headers: response.headers,
        data,
      };
    }
    throw new BadRequestException('Crawler redirect limit exceeded');
  }

  async isNotModified(
    rawUrl: string,
    expectedHostname: string,
    etag?: string | null,
    lastModified?: Date | null,
  ): Promise<boolean> {
    if (!etag && !lastModified) return false;
    const url = await this.urlService.assertPublicUrl(rawUrl);
    if (url.hostname.toLowerCase() !== expectedHostname.toLowerCase())
      return false;
    const response = await axios.head(rawUrl, {
      maxRedirects: 0,
      timeout: 10_000,
      headers: {
        'User-Agent': CRAWLER_USER_AGENT,
        ...(etag ? { 'If-None-Match': etag } : {}),
        ...(lastModified
          ? { 'If-Modified-Since': lastModified.toUTCString() }
          : {}),
      },
      validateStatus: () => true,
    });
    return response.status === 304;
  }
}
