jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import {
  ForbiddenException,
  UnauthorizedException,
  ExecutionContext,
} from '@nestjs/common';
import { VisitorTokenGuard } from './visitor-token.guard';
import { JwtService } from '@nestjs/jwt';

describe('VisitorTokenGuard (INTERNSHIP-207)', () => {
  let guard: VisitorTokenGuard;
  let jwtService: { verifyAsync: jest.Mock };

  beforeEach(() => {
    jwtService = {
      verifyAsync: jest.fn(),
    };
    guard = new VisitorTokenGuard(jwtService as unknown as JwtService);
  });

  function createMockContext(
    headers: Record<string, string> = {},
    params: Record<string, string> = {},
    query: Record<string, string> = {},
  ): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers,
          params,
          query,
        }),
      }),
    } as unknown as ExecutionContext;
  }

  it('rejects with 401 Unauthorized if no token is provided', async () => {
    const context = createMockContext({}, { id: 'conv-123' }, {});
    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException(
        'Visitor token is required to access conversation messages',
      ),
    );
  });

  it('rejects with 401 Unauthorized if token verification fails (invalid or expired)', async () => {
    const context = createMockContext(
      { authorization: 'Bearer invalid.token.here' },
      { id: 'conv-123' },
      {},
    );
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(guard.canActivate(context)).rejects.toThrow(
      new UnauthorizedException('Invalid or expired visitor token'),
    );
  });

  it('rejects with 403 Forbidden if token type is not "visitor"', async () => {
    const context = createMockContext(
      { authorization: 'Bearer valid.token' },
      { id: 'conv-123' },
      {},
    );
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'conv-123',
      conversationId: 'conv-123',
      siteId: 'site-1',
      type: 'user',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException('Token type mismatch'),
    );
  });

  it('rejects with 403 Forbidden if token conversationId does not match route param', async () => {
    const context = createMockContext(
      { authorization: 'Bearer valid.token' },
      { id: 'conv-123' },
      {},
    );
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'conv-999',
      conversationId: 'conv-999',
      siteId: 'site-1',
      type: 'visitor',
    });

    await expect(guard.canActivate(context)).rejects.toThrow(
      new ForbiddenException(
        'Visitor token does not match the requested conversation',
      ),
    );
  });

  it('allows access with valid Bearer token matching conversationId', async () => {
    const context = createMockContext(
      { authorization: 'Bearer valid.visitor.token' },
      { id: 'conv-123' },
      {},
    );
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'conv-123',
      conversationId: 'conv-123',
      siteId: 'site-1',
      type: 'visitor',
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('allows access with valid token in query param "token"', async () => {
    const context = createMockContext(
      {},
      { id: 'conv-123' },
      { token: 'valid.visitor.token' },
    );
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'conv-123',
      conversationId: 'conv-123',
      siteId: 'site-1',
      type: 'visitor',
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });

  it('allows access with valid token in query param "visitorToken"', async () => {
    const context = createMockContext(
      {},
      { id: 'conv-123' },
      { visitorToken: 'valid.visitor.token' },
    );
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'conv-123',
      conversationId: 'conv-123',
      siteId: 'site-1',
      type: 'visitor',
    });

    const result = await guard.canActivate(context);
    expect(result).toBe(true);
  });
});
