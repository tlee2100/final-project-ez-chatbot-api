import { Injectable } from '@nestjs/common';
import { JSDOM } from 'jsdom';
import type {
  PageContextSanitizationResult,
  SanitizedPageContext,
} from './interfaces/page-context.interface';

const FIELD_LIMITS = {
  pageUrl: 2_048,
  pageTitle: 300,
  pageContent: 12_000,
} as const;

type PageContextField = keyof typeof FIELD_LIMITS;

const replaceControlCharacters = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    const isUnsafeControl =
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127;
    return isUnsafeControl ? ' ' : character;
  }).join('');

@Injectable()
export class PageContextService {
  sanitize(
    rawContext: unknown,
    allowedDomains: string[],
    enabled = true,
  ): PageContextSanitizationResult {
    if (rawContext === undefined || rawContext === null) {
      return { reason: 'not_provided', contentLength: 0 };
    }
    if (!enabled) {
      return { reason: 'disabled_by_site', contentLength: 0 };
    }
    if (
      typeof rawContext !== 'object' ||
      Array.isArray(rawContext) ||
      rawContext === null
    ) {
      return { reason: 'invalid_shape', contentLength: 0 };
    }

    const record = rawContext as Record<string, unknown>;
    const rawUrl = record.pageUrl;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return { reason: 'missing_url', contentLength: 0 };
    }

    for (const [field, limit] of Object.entries(FIELD_LIMITS) as [
      PageContextField,
      number,
    ][]) {
      const value = record[field];
      if (value !== undefined && typeof value !== 'string') {
        return { reason: 'invalid_shape', contentLength: 0 };
      }
      if (typeof value === 'string' && value.length > limit) {
        return { reason: 'field_too_large', contentLength: 0 };
      }
    }

    let url: URL;
    try {
      url = new URL(rawUrl.trim());
    } catch {
      return { reason: 'invalid_url', contentLength: 0 };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { reason: 'invalid_url', contentLength: 0 };
    }
    if (url.username || url.password) {
      return { reason: 'url_credentials_not_allowed', contentLength: 0 };
    }

    const hostname = url.hostname.toLowerCase();
    if (!this.isDomainAllowed(hostname, allowedDomains)) {
      return { reason: 'domain_not_allowed', hostname, contentLength: 0 };
    }

    url.search = '';
    url.hash = '';
    const normalizedUrl = url.toString();
    if (normalizedUrl.length > FIELD_LIMITS.pageUrl) {
      return { reason: 'field_too_large', hostname, contentLength: 0 };
    }

    const title = this.cleanText(record.pageTitle);
    const content = this.cleanText(record.pageContent, true);

    const context: SanitizedPageContext = {
      pageUrl: normalizedUrl,
      ...(title ? { pageTitle: title } : {}),
      ...(content ? { pageContent: content } : {}),
    };

    return {
      context,
      reason: 'accepted',
      hostname,
      contentLength: content?.length ?? 0,
    };
  }

  private cleanText(value: unknown, preserveLines = false): string | undefined {
    if (typeof value !== 'string') return undefined;

    const fragment = JSDOM.fragment(value);
    fragment
      .querySelectorAll('script, style, noscript, iframe, form, input')
      .forEach((element) => element.remove());
    const withoutMarkup = fragment.textContent ?? '';
    const withoutControls = replaceControlCharacters(withoutMarkup)
      .replace(/</g, '＜')
      .replace(/>/g, '＞');
    const normalized = preserveLines
      ? withoutControls
          .replace(/\r\n?/g, '\n')
          .replace(/[\t ]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      : withoutControls.replace(/\s+/g, ' ').trim();

    return normalized || undefined;
  }

  private isDomainAllowed(hostname: string, allowedDomains: string[]): boolean {
    const patterns = allowedDomains
      .map((rawPattern) => rawPattern.trim().toLowerCase())
      .filter(Boolean);

    if (patterns.length === 0) return true;

    return patterns.some((pattern) => {
      if (pattern === '*') return true;
      if (pattern.startsWith('*.')) {
        const baseDomain = pattern.slice(2);
        return hostname.endsWith(`.${baseDomain}`);
      }
      return hostname === pattern;
    });
  }
}
