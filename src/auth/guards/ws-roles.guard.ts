import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserRole } from '../../user/enums/user-role.enum';
import type { SocketData } from '../../chat/chat.gateway';

/**
 * WsRolesGuard
 *
 * Enforces role-based access control for WebSocket events (@SubscribeMessage).
 * Reads the authenticated user from `client.data.user` (populated during handshake)
 * and compares it against the required roles defined via `@Roles(...)`.
 */
@Injectable()
export class WsRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const client = context.switchToWs().getClient<Socket>();
    const user = (client?.data as SocketData | undefined)?.user;

    if (!user) {
      throw new WsException('Unauthorized: User is not authenticated');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new WsException('Forbidden: Insufficient permissions');
    }

    return true;
  }
}
