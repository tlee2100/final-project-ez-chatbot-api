import { BadRequestException, Injectable } from '@nestjs/common';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';
import { CRAWLER_MIN_CONTENT_LENGTH } from '../constants/crawler.constants';

export type ExtractedPage = {
  title: string;
  content: string;
  canonicalUrl: string | null;
  noindex: boolean;
  contentHash: string;
};

@Injectable()
export class PageExtractorService {
  extract(html: string, pageUrl: string): ExtractedPage {
    const dom = new JSDOM(html, { url: pageUrl });
    const document = dom.window.document;
    const robots = [
      ...document.querySelectorAll(
        'meta[name="robots"], meta[name="googlebot"]',
      ),
    ]
      .map((element) => element.getAttribute('content')?.toLowerCase() ?? '')
      .join(',');
    const noindex = robots.split(',').some((rule) => rule.trim() === 'noindex');
    const canonicalHref = document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute('href');
    let canonicalUrl: string | null = null;
    if (canonicalHref) {
      try {
        canonicalUrl = new URL(canonicalHref, pageUrl).toString();
      } catch {
        canonicalUrl = null;
      }
    }

    document
      .querySelectorAll('script,style,iframe,form,input,button,noscript')
      .forEach((element) => element.remove());
    const article = new Readability(document).parse();
    const content = (article?.textContent ?? document.body?.textContent ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!noindex && content.length < CRAWLER_MIN_CONTENT_LENGTH) {
      throw new BadRequestException('Page does not contain enough useful text');
    }
    const title = (
      article?.title ||
      document.title ||
      new URL(pageUrl).pathname
    )
      .trim()
      .slice(0, 500);
    return {
      title: title || new URL(pageUrl).hostname,
      content,
      canonicalUrl,
      noindex,
      contentHash: createHash('sha256').update(content).digest('hex'),
    };
  }
}
