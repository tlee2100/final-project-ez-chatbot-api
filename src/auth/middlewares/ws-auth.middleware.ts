import { Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { JwtUser } from '../types/jwt-user.type';
import { UserRole } from 'src/user/enums/user-role.enum';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  organizationId?: string | null;
}

interface SocketData {
  user?: JwtUser;
}

export const WsAuthMiddleware = (jwtService: JwtService) => {
  return (client: Socket, next: (err?: Error) => void) => {
    const token = extractToken(client);
    if (!token) {
      return next(new Error('Missing access token'));
    }

    jwtService
      .verifyAsync<JwtPayload>(token)
      .then((payload) => {
        const data = client.data as SocketData;
        data.user = {
          id: payload.sub,
          email: payload.email,
          role: payload.role as UserRole,
          organizationId: payload.organizationId ?? null,
        };
        next();
      })
      .catch(() => {
        next(new Error('Invalid or expired access token'));
      });
  };
};

function extractToken(client: Socket): string | null {
  const authToken = (client.handshake.auth as Partial<{ token: string }>).token;
  if (typeof authToken === 'string') {
    return authToken;
  }

  const queryToken = client.handshake.query?.token;
  if (typeof queryToken === 'string') {
    return queryToken;
  }

  const authorization = client.handshake.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice(7);
  }

  return null;
}
