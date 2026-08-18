import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CrawlerUrlService } from './crawler-url.service';
import { PageRendererService } from './page-renderer.service';

const describeChromium =
  process.env.RUN_CRAWLER_INTEGRATION === 'true' &&
  process.env.PUPPETEER_EXECUTABLE_PATH
    ? describe
    : describe.skip;

describeChromium('PageRendererService Chromium integration', () => {
  let server: Server;
  let renderer: PageRendererService;
  let fixtureUrl: string;
  let sameHostRedirectUrl: string;
  let crossHostRedirectUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const address = server.address() as AddressInfo;
      if (request.url === '/redirect-same-host') {
        response.writeHead(302, { Location: '/csr' });
        response.end();
        return;
      }
      if (request.url === '/redirect-cross-host') {
        response.writeHead(302, {
          Location: `http://localhost:${address.port}/csr`,
        });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<html><body><main id="app">Loading</main><script>document.querySelector("#app").textContent = "CSR content rendered";</script></body></html>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as AddressInfo).port;
    fixtureUrl = `http://127.0.0.1:${port}/csr`;
    sameHostRedirectUrl = `http://127.0.0.1:${port}/redirect-same-host`;
    crossHostRedirectUrl = `http://127.0.0.1:${port}/redirect-cross-host`;

    const urlService = new CrawlerUrlService();
    jest
      .spyOn(urlService, 'assertPublicUrl')
      .mockImplementation((url) => Promise.resolve(new URL(url)));
    renderer = new PageRendererService(urlService);
  });

  afterAll(async () => {
    await renderer.onModuleDestroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('launches Chromium and captures JavaScript-rendered content', async () => {
    const result = await renderer.render(fixtureUrl);
    expect(result.httpStatus).toBe(200);
    expect(result.html).toContain('CSR content rendered');
  }, 30_000);

  it('follows redirects on the original hostname', async () => {
    const result = await renderer.render(sameHostRedirectUrl);
    expect(result.finalUrl).toBe(fixtureUrl);
  }, 30_000);

  it('blocks redirects that leave the original hostname', async () => {
    await expect(renderer.render(crossHostRedirectUrl)).rejects.toThrow();
  }, 30_000);
});
