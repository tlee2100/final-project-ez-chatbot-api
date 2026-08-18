import { BadRequestException } from '@nestjs/common';
import { PageExtractorService } from './page-extractor.service';

describe('PageExtractorService', () => {
  const service = new PageExtractorService();

  it('extracts readable content, canonical URL, title, and stable hash', () => {
    const html = `
      <html><head><title>Help center</title><link rel="canonical" href="/guide" /></head>
      <body><nav>Navigation</nav><main><h1>Getting started</h1>
      <p>This guide contains enough useful customer support content to be indexed by the crawler.</p>
      <script>window.secret = 'ignored'</script></main></body></html>`;

    const first = service.extract(html, 'https://example.com/guide?ref=menu');
    const second = service.extract(html, 'https://example.com/guide?ref=menu');

    expect(first.title).toBe('Help center');
    expect(first.content).toContain('Getting started');
    expect(first.canonicalUrl).toBe('https://example.com/guide');
    expect(first.content).not.toContain('window.secret');
    expect(first.contentHash).toBe(second.contentHash);
  });

  it('recognizes noindex directives', () => {
    const result = service.extract(
      '<html><head><meta name="robots" content="noindex, follow" /></head><body><main>This page has enough text but explicitly asks search and knowledge crawlers not to index its content.</main></body></html>',
      'https://example.com/private',
    );
    expect(result.noindex).toBe(true);
  });

  it('returns noindex before enforcing minimum content length', () => {
    const result = service.extract(
      '<html><head><meta name="robots" content="noindex" /></head><body>Hidden</body></html>',
      'https://example.com/hidden',
    );
    expect(result.noindex).toBe(true);
  });

  it('rejects pages without useful content', () => {
    expect(() =>
      service.extract(
        '<html><body><nav>Home</nav></body></html>',
        'https://example.com',
      ),
    ).toThrow(BadRequestException);
  });
});
