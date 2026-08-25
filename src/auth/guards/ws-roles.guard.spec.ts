import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { WsRolesGuard } from './ws-roles.guard';
import { UserRole } from '../../user/enums/user-role.enum';

describe('WsRolesGuard', () => {
  let guard: WsRolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new WsRolesGuard(reflector);
  });

  const createMockContext = (
    user?: { id: string; role: UserRole; email: string },
    requiredRoles?: UserRole[],
  ): ExecutionContext => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(requiredRoles);

    return {
      switchToWs: () => ({
        getClient: () => ({
          data: {
            user,
          },
        }),
        getData: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  };

  it('should allow access if no roles are required', () => {
    const context = createMockContext(undefined, undefined);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('should throw WsException if roles are required but client has no user', () => {
    const context = createMockContext(undefined, [UserRole.ADMIN]);
    expect(() => guard.canActivate(context)).toThrow(WsException);
    expect(() => guard.canActivate(context)).toThrow(
      'Unauthorized: User is not authenticated',
    );
  });

  it('should throw WsException if user does not have the required role', () => {
    const context = createMockContext(
      { id: 'u-1', email: 'agent@test.com', role: UserRole.AGENT },
      [UserRole.ADMIN, UserRole.SUPER_ADMIN],
    );
    expect(() => guard.canActivate(context)).toThrow(WsException);
    expect(() => guard.canActivate(context)).toThrow(
      'Forbidden: Insufficient permissions',
    );
  });

  it('should allow access if user has one of the required roles', () => {
    const context = createMockContext(
      { id: 'u-1', email: 'admin@test.com', role: UserRole.ADMIN },
      [UserRole.ADMIN, UserRole.SUPER_ADMIN],
    );
    expect(guard.canActivate(context)).toBe(true);
  });
});
