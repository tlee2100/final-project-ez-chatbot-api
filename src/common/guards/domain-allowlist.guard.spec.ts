jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { DomainAllowlistGuard } from './domain-allowlist.guard';
import { createRepositoryMock } from '../../test/service-test-helpers';

describe('DomainAllowlistGuard (INTERNSHIP-211)', () => {
  let guard: DomainAllowlistGuard;
  let siteRepository: ReturnType<typeof createRepositoryMock>;

  beforeEach(() => {
    siteRepository = createRepositoryMock();
    guard = new DomainAllowlistGuard(siteRepository as never);
  });

  function createMockContext(
    headers: Record<string, string> = {},
    params: Record<string, string> = {},
    body: Record<string, unknown> = {},
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          params,
          body,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('passes through if no siteId is present in request', async () => {
    const context = createMockContext({}, {}, {});
    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('blocks request with 403 Forbidden if Origin header is missing (INTERNSHIP-211)', async () => {
    const context = createMockContext({}, { siteId: 'site-1' }, {});
    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException(
        'Origin header is required for public widget requests',
      ),
    );
  });

  it('blocks request if site is not found', async () => {
    const context = createMockContext(
      { origin: 'https://example.com' },
      { siteId: 'site-1' },
      {},
    );
    siteRepository.findOne.mockResolvedValue(null);

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException('Site not found or access denied'),
    );
  });

  it('blocks request if allowedDomains is empty', async () => {
    const context = createMockContext(
      { origin: 'https://example.com' },
      { siteId: 'site-1' },
      {},
    );
    siteRepository.findOne.mockResolvedValue({
      id: 'site-1',
      allowedDomains: [],
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException(
        'Site configuration error: No allowed domains configured',
      ),
    );
  });

  it('blocks request if Origin is not in allowedDomains', async () => {
    const context = createMockContext(
      { origin: 'https://attacker.com' },
      { siteId: 'site-1' },
      {},
    );
    siteRepository.findOne.mockResolvedValue({
      id: 'site-1',
      allowedDomains: ['example.com'],
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException(
        'Origin "https://attacker.com" is not allowed for this site',
      ),
    );
  });

  it('allows request if Origin matches exact allowed domain', async () => {
    const context = createMockContext(
      { origin: 'https://example.com' },
      { siteId: 'site-1' },
      {},
    );
    siteRepository.findOne.mockResolvedValue({
      id: 'site-1',
      allowedDomains: ['example.com'],
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('allows request if Origin matches wildcard subdomain', async () => {
    const context = createMockContext(
      { origin: 'https://sub.example.com' },
      { siteId: 'site-1' },
      {},
    );
    siteRepository.findOne.mockResolvedValue({
      id: 'site-1',
      allowedDomains: ['*.example.com'],
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
