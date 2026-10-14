import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { SiteService } from 'src/site/site.service';
import type { JwtUser } from 'src/auth/types/jwt-user.type';

/**
 * Multi-Tenant Isolation
 *
 * Intercepts requests to site-scoped routes (`/sites/:siteId/*`) and verifies
 * that the authenticated user belongs to the same organisation as the site.
 * Delegates the access-policy check to `SiteService.assertSiteAccess` which
 * already handles SUPER_ADMIN bypass, org-scoping, agent assignment, etc.
 *
 * Apply at controller level: `@UseInterceptors(TenantScopeInterceptor)`
 */
@Injectable()
export class TenantScopeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantScopeInterceptor.name);

  constructor(private readonly siteService: SiteService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const siteId = request.params['siteId'] as string | undefined;
    const user = request['user'] as JwtUser | undefined;

    if (!siteId || !user) {
      // Not a tenant-scoped route or no authenticated user — pass through
      return next.handle();
    }

    try {
      await this.siteService.assertSiteAccess(siteId, user);
      this.logger.debug(
        `Tenant access verified — user: ${user.id}, site: ${siteId}`,
      );
    } catch {
      this.logger.warn(
        `Tenant access DENIED — user: ${user.id}, site: ${siteId}`,
      );
      throw new ForbiddenException('You do not have access to this site');
    }

    return next.handle();
  }
}
