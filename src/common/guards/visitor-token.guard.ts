import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export interface VisitorTokenPayload {
  sub: string;
  conversationId: string;
  siteId: string;
  type: string;
  iat?: number;
  exp?: number;
}

/**
 * VisitorTokenGuard
 *
 * Enforces that requests to public visitor conversation endpoints (e.g. transcript retrieval)
 * present a valid, signed JWT scoped specifically to the requested conversation.
 *
 * Security Requirements (INTERNSHIP-207):
 * 1. Token must be present in Authorization header (Bearer) or query param (`token` or `visitorToken`).
 * 2. Token signature and expiration must be valid.
 * 3. Token payload type must be 'visitor'.
 * 4. Token conversationId (or sub) must match the requested route parameter :id.
 */
@Injectable()
export class VisitorTokenGuard implements CanActivate {
  private readonly logger = new Logger(VisitorTokenGuard.name);

  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawConvId = request.params['id'] ?? request.params['conversationId'];
    const conversationId: string =
      typeof rawConvId === 'string' ? rawConvId : '';

    const token = this.extractToken(request);

    if (!token) {
      this.logger.warn(
        `[VisitorTokenGuard] Missing visitor token for conversationId=${conversationId}`,
      );
      throw new UnauthorizedException(
        'Visitor token is required to access conversation messages',
      );
    }

    let payload: VisitorTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<VisitorTokenPayload>(token);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `[VisitorTokenGuard] Token verification failed for conversationId=${conversationId}: ${errMsg}`,
      );
      throw new UnauthorizedException('Invalid or expired visitor token');
    }

    if (payload.type !== 'visitor') {
      this.logger.warn(
        `[VisitorTokenGuard] Invalid token type "${payload.type}" for conversationId=${conversationId}`,
      );
      throw new ForbiddenException('Token type mismatch');
    }

    const tokenConvId = payload.conversationId || payload.sub;
    if (tokenConvId !== conversationId) {
      this.logger.warn(
        `[VisitorTokenGuard] Conversation ID mismatch: token=${tokenConvId}, requested=${conversationId}`,
      );
      throw new ForbiddenException(
        'Visitor token does not match the requested conversation',
      );
    }

    // Attach verified visitor payload to request for downstream handler use if needed
    (request as unknown as { visitor?: VisitorTokenPayload }).visitor = payload;

    return true;
  }

  private extractToken(req: Request): string | null {
    const authHeader = req.headers['authorization'];
    if (
      typeof authHeader === 'string' &&
      authHeader.toLowerCase().startsWith('bearer ')
    ) {
      return authHeader.slice(7).trim();
    }

    const query = req.query as Record<string, unknown> | undefined;
    if (typeof query?.['token'] === 'string' && query['token']) {
      return query['token'];
    }
    if (typeof query?.['visitorToken'] === 'string' && query['visitorToken']) {
      return query['visitorToken'];
    }

    return null;
  }
}
