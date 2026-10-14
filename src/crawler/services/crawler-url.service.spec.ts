import { BadRequestException } from '@nestjs/common';
import { CrawlerUrlService } from './crawler-url.service';

describe('CrawlerUrlService', () => {
  const service = new CrawlerUrlService();

  it('normalizes tracking parameters, fragments, ports, and query order', () => {
    expect(
      service.normalize(
        'HTTPS://Example.COM:443/help?utm_source=test&b=2&a=1#section',
      ),
    ).toBe('https://example.com/help?a=1&b=2');
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.1.1',
    '2001:db8::1',
  ])('blocks non-public address %s', (address) => {
    expect(service.isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(service.isPublicAddress(address)).toBe(true);
    },
  );

  it('rejects credentials and non-web protocols before DNS lookup', async () => {
    await expect(
      service.assertPublicUrl('https://user:pass@example.com'),
    ).rejects.toThrow(BadRequestException);
    await expect(service.assertPublicUrl('file:///etc/passwd')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects non-standard ports before DNS lookup', async () => {
    await expect(
      service.assertPublicUrl('https://example.com:8443/help'),
    ).rejects.toThrow('ports 80 and 443');
  });
});
