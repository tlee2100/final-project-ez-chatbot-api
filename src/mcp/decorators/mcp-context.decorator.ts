import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { McpValidatedContext } from '../types/mcp.types';

export const McpContext = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): McpValidatedContext => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const rawHeader =
      request.headers['x-mcp-context'] || request.headers['X-MCP-Context'];

    if (!rawHeader || typeof rawHeader !== 'string') {
      throw new UnauthorizedException('Missing required X-MCP-Context header');
    }

    try {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error('JWT_SECRET is not configured');
      }

      const decoded = jwt.verify(
        rawHeader,
        secret,
      ) as unknown as McpValidatedContext;

      if (!decoded.siteId) {
        throw new UnauthorizedException(
          'Invalid MCP token payload: missing siteId',
        );
      }

      return decoded;
    } catch {
      throw new UnauthorizedException('Invalid or expired X-MCP-Context token');
    }
  },
);
