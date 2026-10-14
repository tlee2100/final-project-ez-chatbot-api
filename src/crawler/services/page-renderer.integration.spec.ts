import { CrawlerUrlService } from './crawler-url.service';
import { PageRendererService } from './page-renderer.service';

const describeBrowserless =
  process.env.RUN_CRAWLER_INTEGRATION === 'true' &&
  process.env.BROWSER_WS_ENDPOINT &&
  process.env.CRAWLER_INTEGRATION_URL
    ? describe
    : describe.skip;

describeBrowserless('PageRendererService Browserless integration', () => {
  let renderer: PageRendererService;
  let fixtureUrl: string;

  beforeAll(() => {
    fixtureUrl = process.env.CRAWLER_INTEGRATION_URL!;
    const urlService = new CrawlerUrlService();
    renderer = new PageRendererService(urlService);
  });

  it('connects to Browserless and renders a public page', async () => {
    const result = await renderer.render(fixtureUrl);
    expect(result.httpStatus).toBeLessThan(400);
    expect(result.html).toContain('<html');
  }, 60_000);
});
