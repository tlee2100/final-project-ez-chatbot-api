import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * MCP-002: Guards all /api/internal/mcp/* routes.
 * Validates the X-MCP-Secret header against MCP_INTERNAL_SECRET env var.
 * Returns 401 Unauthorized if the secret is missing or does not match.
 *
 * This guard prevents the widget, admin dashboard, or external callers from
 * directly calling internal MCP endpoints — only ez-mcp-server may call them.
 */
@Injectable()
export class McpSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedSecret = process.env.MCP_INTERNAL_SECRET;

    if (!expectedSecret) {
      throw new UnauthorizedException(
        'MCP_INTERNAL_SECRET is not configured on this server.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedSecret = request.headers['x-mcp-secret'];

    if (!providedSecret || providedSecret !== expectedSecret) {
      throw new UnauthorizedException(
        'Invalid or missing X-MCP-Secret header.',
      );
    }

    return true;
  }
}
