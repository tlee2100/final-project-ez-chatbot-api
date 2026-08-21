import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { Request } from 'express';

/**
 * API Rate Limiting (per siteId + IP) — SEC-005
 *
 * Extends NestJS's built-in ThrottlerGuard to use a composite tracker key
 * of `<siteId>-<clientIP>` instead of just IP address. This allows each
 * site's callers to be rate-limited independently.
 *
 * Key resolution order:
 *  1. request.params.siteId  (REST routes with siteId in the path)
 *  2. request.body.siteId    (public chat routes send siteId in the body)
 *  3. 'global'               (fallback — still rate-limits but not per-site)
 *
 * ThrottlerModule global limits are registered in AppModule.
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(ApiThrottlerGuard.name);

  protected getTracker(request: Request): Promise<string> {
    const params = request.params as Record<string, string> | undefined;
    const body = request.body as Record<string, unknown> | undefined;

    // Read siteId from params first (path variable), then body (public chat endpoints)
    const siteId =
      params?.['siteId'] ??
      (typeof body?.['siteId'] === 'string' ? body['siteId'] : undefined) ??
      'global';

    const ip =
      (request.ips && request.ips.length > 0 ? request.ips[0] : null) ??
      request.ip ??
      'unknown';

    const tracker = `${siteId}-${ip}`;
    this.logger.debug(`Rate-limit tracker key: ${tracker}`);
    return Promise.resolve(tracker);
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
  ): Promise<void> {
    const request = context.switchToHttp().getRequest<Request>();
    this.logger.warn(
      `Rate limit exceeded — tracker: ${await this.getTracker(request)}`,
    );
    throw new ThrottlerException();
  }
}
