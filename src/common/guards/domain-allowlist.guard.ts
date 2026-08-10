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
      return true; // No siteId found — not a tenant-scoped endpoint or missing payload (will be caught by validation)
    }

    const origin = request.headers['origin'] ?? '';

    // No Origin header means this is a same-origin, server-to-server, or non-browser request
    // (e.g. Postman, curl, testchat.html opened from local filesystem). Allow it through.
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
        `[DomainAllowlistGuard] Site not found in DB — siteId=${siteId}, origin=${origin}`,
      );
      throw new ForbiddenException('Site not found or access denied');
    }

    // DEBUG: log actual DB value so we can trace unexpected 403s
    this.logger.debug(
      `[DomainAllowlistGuard] site=${siteId} allowedDomains=${JSON.stringify(site.allowedDomains)} origin=${origin}`,
    );

    // If no allowedDomains configured, block access (strict security)
    if (!site.allowedDomains?.length) {
      this.logger.warn(
        `[DomainAllowlistGuard] Site has no allowedDomains configured — siteId=${siteId}, origin=${origin}`,
      );
      throw new ForbiddenException(
        `Site configuration error: No allowed domains configured`,
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
        const baseDomain = pattern.slice(2); // 'example.com'
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
