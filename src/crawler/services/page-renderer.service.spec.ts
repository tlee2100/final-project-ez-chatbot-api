import type { Browser } from 'puppeteer-core';
import { CrawlerUrlService } from './crawler-url.service';
import { PageRendererService } from './page-renderer.service';

describe('PageRendererService', () => {
  it('closes the Browserless session after rendering', async () => {
    const response = {
      headers: jest.fn().mockReturnValue({}),
      status: jest.fn().mockReturnValue(200),
    };
    const page = {
      setUserAgent: jest.fn(),
      setRequestInterception: jest.fn(),
      on: jest.fn(),
      goto: jest.fn().mockResolvedValue(response),
      waitForNetworkIdle: jest.fn().mockResolvedValue(undefined),
      url: jest.fn().mockReturnValue('https://example.com/'),
      content: jest.fn().mockResolvedValue('<html></html>'),
    };
    const context = {
      newPage: jest.fn().mockResolvedValue(page),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const browser = {
      createBrowserContext: jest.fn().mockResolvedValue(context),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const urlService = {
      assertPublicUrl: jest
        .fn()
        .mockImplementation((url: string) => Promise.resolve(new URL(url))),
    } as unknown as CrawlerUrlService;
    const renderer = new PageRendererService(urlService);
    jest
      .spyOn(
        renderer as unknown as { connectBrowser(): Promise<Browser> },
        'connectBrowser',
      )
      .mockResolvedValue(browser as unknown as Browser);

    const result = await renderer.render('https://example.com/');

    expect(result.httpStatus).toBe(200);
    expect(context.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });
});
