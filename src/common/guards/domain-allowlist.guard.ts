import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { Site } from 'src/site/entities/site.entity';

/**
 * Domain Allowlist Validation
 *
 * Guards public chat endpoints so that only requests whose `Origin` header
 * matches the site's `allowedDomains` list can start a conversation.
 * Supports exact matches and wildcard subdomains (e.g. `*.example.com`).
 *
 * Validation Rules:
 * 1. No siteId in request → Pass (not a site-scoped endpoint).
 * 2. No Origin header    → Pass (non-browser, server-to-server, or Postman requests).
 * 3. Origin matches allowedDomains → Pass.
 * 4. Otherwise → Reject with 403 Forbidden.
 *
 * NOTE: Authenticated admin/agent requests do NOT use this public guard;
 * they must use dedicated endpoints (e.g. POST /chat/admin-test/conversations)
 * protected by JwtAuthGuard.
 */
@Injectable()
export class DomainAllowlistGuard implements CanActivate {
  private readonly logger = new Logger(DomainAllowlistGuard.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    const body = request.body as Record<string, unknown> | undefined;
    const bodySiteId =
      typeof body?.['siteId'] === 'string' ? body['siteId'] : undefined;
    const siteId = (request.params['siteId'] || bodySiteId) as
      string | undefined;

    if (!siteId) {
      // No siteId — not a tenant-scoped endpoint or missing payload
      // (will be caught downstream by validation pipe).
      return true;
    }

    const origin = request.headers['origin'] ?? '';

    // No Origin header → same-origin, server-to-server, or non-browser request
    // (e.g. Postman, curl, testchat.html from local filesystem). Allow through.
    if (!origin) {
      this.logger.debug(
        `[DomainAllowlistGuard] No Origin header — allowing site: ${siteId}`,
      );
      return true;
    }

    let site: Site | null;
    try {
      site = await this.siteRepository.findOne({
        where: { id: siteId },
        select: { id: true, allowedDomains: true },
      });
    } catch (err) {
      this.logger.warn(
        `[DomainAllowlistGuard] DB error for siteId=${siteId}: ${String(err)}`,
      );
      throw new ForbiddenException('Site not found or access denied');
    }

    if (!site) {
      this.logger.warn(
        `[DomainAllowlistGuard] Site not found — siteId=${siteId}, origin=${origin}`,
      );
      throw new ForbiddenException('Site not found or access denied');
    }

    this.logger.debug(
      `[DomainAllowlistGuard] site=${siteId} allowedDomains=${JSON.stringify(site.allowedDomains)} origin=${origin}`,
    );

    if (!site.allowedDomains?.length) {
      this.logger.warn(
        `[DomainAllowlistGuard] No allowedDomains configured — siteId=${siteId}, origin=${origin}`,
      );
      throw new ForbiddenException(
        'Site configuration error: No allowed domains configured',
      );
    }

    const allowed = this.isDomainAllowed(origin, site.allowedDomains);
    if (!allowed) {
      this.logger.warn(
        `Domain not allowed — site: ${siteId}, origin: ${origin}, allowedDomains: ${JSON.stringify(site.allowedDomains)}`,
      );
      throw new ForbiddenException(
        `Origin "${origin}" is not allowed for this site`,
      );
    }

    return true;
  }

  private isDomainAllowed(origin: string, allowedDomains: string[]): boolean {
    const hostname = this.extractHostname(origin);
    if (!hostname) return false;

    return allowedDomains.some((pattern) => {
      if (pattern.startsWith('*.')) {
        // Wildcard: *.example.com matches sub.example.com but NOT example.com
        const baseDomain = pattern.slice(2);
        return hostname.endsWith(`.${baseDomain}`);
      }
      return hostname === pattern;
    });
  }

  private extractHostname(origin: string): string | null {
    try {
      return new URL(origin).hostname;
    } catch {
      return null;
    }
  }
}
