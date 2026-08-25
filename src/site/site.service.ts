import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Logger,
} from '@nestjs/common';
import { encryptApiKey, decryptApiKey } from '../shared/utils/encryption.util';
import OpenAI from 'openai';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { type PaginateQuery, type Paginated, paginate } from 'nestjs-paginate';
import type { Mapper } from '@automapper/core';
import { InjectMapper } from '@automapper/nestjs';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Redis } from 'ioredis';

import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { Site } from './entities/site.entity';
import { User } from '../user/entities/user.entity';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/enums/notification-type.enum';

import { SiteDto } from './dto/site.dto';
import { UserRole } from '../user/enums/user-role.enum';
import type { JwtUser } from 'src/auth/types/jwt-user.type';
import { SITE_PAGINATION_CONFIG } from './config/site-pagination.config';
import { ChatGateway } from '../chat/chat.gateway';
import { ChatTimeoutService } from '../chat/chat-timeout.service';
import {
  Conversation,
  ConversationStatus,
} from '../chat/entities/conversation.entity';
import { Document } from '../document/entities/document.entity';
import { CrawlerService } from '../crawler/crawler.service';

type PaginatedSiteDtos = Omit<Paginated<Site>, 'data'> & {
  data: SiteDto[];
};

@Injectable()
export class SiteService {
  private readonly logger = new Logger(SiteService.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectMapper()
    private readonly mapper: Mapper,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => ChatTimeoutService))
    private readonly chatTimeoutService: ChatTimeoutService,
    @Inject(forwardRef(() => CrawlerService))
    private readonly crawlerService: CrawlerService,
    @Inject('REDIS_CLIENT')
    private readonly redis: Redis,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  // ── Create Site ──
  async create(createSiteDto: CreateSiteDto, user: JwtUser): Promise<SiteDto> {
    const { agentIds, ...siteData } = createSiteDto;

    // Admins can only create sites within their own organization.
    if (!user.organizationId) {
      throw new BadRequestException(
        'Admin must belong to an organization to create a site',
      );
    }
    const organizationId = user.organizationId;

    const owner = await this.userRepository.findOne({
      where: { id: user.id },
    });

    if (!owner) {
      throw new NotFoundException('Owner not found');
    }

    // An organization-scoped admin must belong to an organization so the site
    // is tenant-bound. Super-admins may create tenantless sites.
    if (owner.role === UserRole.ADMIN && !owner.organizationId) {
      throw new BadRequestException(
        'Admin must belong to an organization to create a site',
      );
    }

    const existingSite = await this.siteRepository.findOne({
      where: { url: siteData.url },
    });
    if (existingSite) {
      throw new ConflictException('Site with this URL already exists');
    }

    const site = this.siteRepository.create({
      ...siteData,
      allowedDomains: siteData.allowedDomains
        ? this.sanitizeAllowedDomains(siteData.allowedDomains)
        : [],
      owner,
      organizationId,
    });

    if (agentIds?.length) {
      const agents = await this.userRepository.find({
        where: {
          id: In(agentIds),
          role: UserRole.AGENT,
        },
      });
      site.agents = agents;
    }

    const savedSite = await this.siteRepository.save(site);
    return this.mapper.map(savedSite, Site, SiteDto);
  }

  // ── Find All (Paginated) ──
  async findAll(
    query: PaginateQuery,
    user: JwtUser,
  ): Promise<PaginatedSiteDtos> {
    const qb = this.siteRepository
      .createQueryBuilder('site')
      .leftJoinAndSelect('site.owner', 'owner')
      .leftJoinAndSelect('site.agents', 'agents')
      .loadRelationIdAndMap('site.documentIds', 'site.documents');

    // Organization-based visibility: non-super-admin users only see sites
    // belonging to their own organization.
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (user.organizationId) {
        qb.andWhere('site.organizationId = :orgId', {
          orgId: user.organizationId,
        });
      } else {
        // Belongs to no organization — see nothing.
        qb.andWhere('1 = 0');
      }
    }

    // Agents additionally see only the sites they are assigned to (now also
    // constrained to their own organization by the filter above).
    if (user.role === UserRole.AGENT) {
      qb.innerJoin('site.agents', 'agent', 'agent.id = :agentId', {
        agentId: user.id,
      });
    } else if (user.role === UserRole.ADMIN && user.organizationId) {
      qb.andWhere('site.organizationId = :orgId', {
        orgId: user.organizationId,
      });
    }

    const paginated = await paginate(query, qb, SITE_PAGINATION_CONFIG);

    const siteIds = paginated.data.map((s) => s.id);
    const activeChatsMap: Record<string, number> = {};

    if (siteIds.length > 0) {
      const activeChatsRows = await this.siteRepository.manager
        .createQueryBuilder(Conversation, 'conversation')
        .select('conversation.siteId', 'siteId')
        .addSelect('COUNT(conversation.id)', 'count')
        .where('conversation.siteId IN (:...siteIds)', { siteIds })
        .andWhere('conversation.status != :closedStatus', {
          closedStatus: ConversationStatus.CLOSED,
        })
        .groupBy('conversation.siteId')
        .getRawMany<{ siteId: string; count: string }>();

      activeChatsRows.forEach((row) => {
        activeChatsMap[row.siteId] = parseInt(row.count, 10);
      });
    }

    const dtos = this.mapper
      .mapArray(paginated.data, Site, SiteDto)
      .map((dto) => {
        dto.activeChats = activeChatsMap[dto.id] || 0;
        dto.updatedAt = new Date().toISOString(); // Fallback for updatedAt
        return dto;
      });

    return {
      ...paginated,
      data: dtos,
    };
  }

  // ── Find One Site Entity (Internal) ──
  async findOneEntity(id: string): Promise<Site> {
    const site = await this.siteRepository.findOne({
      where: { id },
      relations: {
        owner: true,
        agents: true,
        documents: true,
        bookingConfig: true,
        bookingServices: true,
        bookingResources: true,
        industryTemplateInfo: true,
      },
    });
    if (!site) {
      throw new NotFoundException(`Site with id ${id} not found`);
    }
    return site;
  }

  // ── Find One Site Dto (Public — no authorization; caller exposes only
  //    deliberately public fields) ──
  async findOne(id: string): Promise<SiteDto> {
    const site = await this.findOneEntity(id);
    const dto = this.mapper.map(site, Site, SiteDto);

    const activeChatsCount = await this.siteRepository.manager
      .createQueryBuilder(Conversation, 'conversation')
      .where('conversation.siteId = :siteId', { siteId: id })
      .andWhere('conversation.status != :closedStatus', {
        closedStatus: ConversationStatus.CLOSED,
      })
      .getCount();
    dto.activeChats = activeChatsCount;
    dto.updatedAt = new Date().toISOString();

    return dto;
  }

  // ── Find One Site Dto (Access-checked) ──
  async findOneWithAccess(id: string, user: JwtUser): Promise<SiteDto> {
    const site = await this.assertSiteAccess(id, user);
    const dto = this.mapper.map(site, Site, SiteDto);

    const activeChatsCount = await this.siteRepository.manager
      .createQueryBuilder(Conversation, 'conversation')
      .where('conversation.siteId = :siteId', { siteId: id })
      .andWhere('conversation.status != :closedStatus', {
        closedStatus: ConversationStatus.CLOSED,
      })
      .getCount();
    dto.activeChats = activeChatsCount;
    dto.updatedAt = new Date().toISOString();

    return dto;
  }

  // ── Assert access helper ──
  async assertSiteAccess(siteId: string, user: JwtUser): Promise<Site> {
    const site = await this.findOneEntity(siteId);

    // Super admins have unrestricted access.
    if (user.role === UserRole.SUPER_ADMIN) {
      return site;
    }

    // Every other role may only access sites within their own organization.
    if (!user.organizationId || site.organizationId !== user.organizationId) {
      throw new ForbiddenException('You do not have access to this site');
    }

    // Within their organization, admins have full access.
    if (user.role === UserRole.ADMIN) {
      return site;
    }

    // Agents must be the owner of or be assigned to the site.
    const isOwner = site.ownerId === user.id;
    const isAssignedAgent = site.agents.some((agent) => agent.id === user.id);

    if (!isOwner && !isAssignedAgent) {
      throw new ForbiddenException('You do not have access to this site');
    }
    return site;
  }

  // ── Update Site ──
  async update(
    id: string,
    dto: UpdateSiteDto,
    user: JwtUser,
  ): Promise<SiteDto> {
    const site = await this.assertSiteAccess(id, user);

    if (dto.url && dto.url !== site.url) {
      const existingSite = await this.siteRepository.findOne({
        where: { url: dto.url },
      });
      if (existingSite && existingSite.id !== id) {
        throw new ConflictException('Site with this URL already exists');
      }
    }

    const updateData = { ...dto };
    if (dto.useCustomOpenAiKey === true && !site.encryptedOpenAiKey) {
      updateData.useCustomOpenAiKey = false;
    }
    if (dto.allowedDomains !== undefined) {
      updateData.allowedDomains = this.sanitizeAllowedDomains(
        dto.allowedDomains,
      );
    }

    await this.siteRepository.update(id, updateData);
    const updatedSite = await this.findOne(id);

    // Refresh conversation timeout timers if timeout settings were modified
    if (
      dto.enableConversationTimeout !== undefined ||
      dto.inactivityTimeoutMinutes !== undefined ||
      dto.warningTimeMinutes !== undefined ||
      dto.pauseTimerForAgentChats !== undefined ||
      dto.resetTimerOnBotResponse !== undefined
    ) {
      void this.chatTimeoutService.refreshSiteTimers(id);
    }

    // Broadcast updated settings to active conversations
    const conversations = await this.siteRepository.manager
      .createQueryBuilder()
      .select('conversation.id', 'id')
      .from('conversations', 'conversation')
      .where('conversation.siteId = :siteId', { siteId: id })
      .andWhere("conversation.status != 'CLOSED'")
      .getRawMany<{ id: string }>();

    if (dto.isAiActive === false) {
      await this.siteRepository.manager.query(
        `UPDATE conversations SET "isAiActive" = false, "handlingStatus" = 'WAITING_FOR_AGENT' WHERE "siteId" = $1 AND status != 'CLOSED' AND "handlingStatus" = 'AI_HANDLING'`,
        [id],
      );
      if (conversations.length > 0) {
        for (const conv of conversations) {
          this.chatGateway.server
            .to(`conversation-${conv.id}`)
            .emit('handlingStatusUpdated', {
              conversationId: conv.id,
              handlingStatus: 'WAITING_FOR_AGENT',
            });
        }
      }
    }

    if (conversations.length > 0) {
      const conversationIds = conversations.map((c) => c.id);
      this.chatGateway.broadcastSiteSettingsUpdated(
        conversationIds,
        updatedSite,
      );
    }
    this.chatGateway.server
      .to(`site-${id}`)
      .emit('siteSettingsUpdated', updatedSite);

    return updatedSite;
  }

  // ── Delete Site ──
  async remove(id: string, user: JwtUser): Promise<void> {
    await this.assertSiteAccess(id, user);

    // 1. Cancel in-memory conversation timers
    try {
      await this.chatTimeoutService.cancelAllTimersForSite(id);
    } catch (timerErr) {
      this.logger.warn(
        `Failed to cancel timers for site ${id}:`,
        timerErr instanceof Error ? timerErr.stack : timerErr,
      );
    }

    // 2. Remove any scheduled Bull repeatable jobs for crawler
    try {
      if (this.crawlerService) {
        await this.crawlerService.removeSiteRepeatableJob(id);
      }
    } catch (crawlerErr) {
      this.logger.warn(
        `Failed to remove crawler job for site ${id}:`,
        crawlerErr instanceof Error ? crawlerErr.stack : crawlerErr,
      );
    }

    // 3. Clean up Cloudinary assets (Documents and site images)
    try {
      const documents = await this.documentRepository.find({
        where: { siteId: id },
        select: { id: true, cloudinaryPublicId: true },
      });

      for (const doc of documents) {
        if (doc.cloudinaryPublicId) {
          await cloudinary.uploader
            .destroy(doc.cloudinaryPublicId, {
              resource_type: 'raw',
            })
            .catch(() => {});
        }
      }

      await cloudinary.api
        .delete_resources_by_prefix(`sites/${id}/`, {
          resource_type: 'raw',
        })
        .catch(() => {});

      await cloudinary.api
        .delete_resources_by_prefix(`sites/${id}/`, {
          resource_type: 'image',
        })
        .catch(() => {});

      await cloudinary.api
        .delete_folder(`sites/${id}/documents`)
        .catch(() => {});
      await cloudinary.api.delete_folder(`sites/${id}`).catch(() => {});
    } catch (cloudinaryErr) {
      this.logger.warn(
        `Failed to clean up Cloudinary assets for site ${id}:`,
        cloudinaryErr instanceof Error ? cloudinaryErr.stack : cloudinaryErr,
      );
    }

    // 4. Clean up any temporary Redis slot hold keys for this site
    try {
      if (this.redis) {
        const holdKeys = await this.redis.keys(`hold:${id}:*`);
        if (holdKeys.length > 0) {
          await this.redis.del(...holdKeys);
        }
      }
    } catch (redisErr) {
      this.logger.warn(
        `Failed to clear Redis hold keys for site ${id}:`,
        redisErr instanceof Error ? redisErr.stack : redisErr,
      );
    }

    // 5. Database deletion (DB CASCADE handles all child entities)
    try {
      await this.siteRepository.delete(id);
    } catch (error) {
      const err = error as { code?: string };
      if (err?.code === '23503') {
        throw new BadRequestException(
          'Cannot delete this site due to a database constraint. It may still be linked to other records.',
        );
      }
      throw error;
    }
  }

  // ── Assign Agent ──
  async assignAgent(
    siteId: string,
    agentId: string,
    user: JwtUser,
  ): Promise<SiteDto> {
    const site = await this.assertSiteAccess(siteId, user);

    const alreadyAssigned = site.agents.some((agent) => agent.id === agentId);
    if (alreadyAssigned) {
      throw new BadRequestException('Agent is already assigned to this site');
    }

    const newAgent = await this.userRepository.findOne({
      where: { id: agentId },
    });

    await this.siteRepository
      .createQueryBuilder()
      .relation(Site, 'agents')
      .of(siteId)
      .add(agentId);

    // Send notification to the newly assigned agent
    await this.notificationService.create({
      recipientId: agentId,
      type: NotificationType.SYSTEM,
      title: 'Assigned to Site',
      message: `You have been added to the site '${site.name}'.`,
      siteId: site.id,
    });

    // Notify other site users (owner and existing agents)
    const usersToNotify = new Set<string>();
    if (site.ownerId) usersToNotify.add(site.ownerId);
    site.agents.forEach((agent) => usersToNotify.add(agent.id));

    // Don't notify the newly assigned agent twice, just in case
    usersToNotify.delete(agentId);

    const agentName = newAgent ? newAgent.name : 'A new agent';
    const notifyPromises = Array.from(usersToNotify).map((id) =>
      this.notificationService.create({
        recipientId: id,
        type: NotificationType.SYSTEM,
        title: 'New Agent Assigned',
        message: `${agentName} has been assigned to the site '${site.name}'.`,
        siteId: site.id,
      }),
    );
    await Promise.all(notifyPromises);

    return this.findOne(siteId);
  }

  // ── Remove Agent ──
  async removeAgent(
    siteId: string,
    agentId: string,
    user: JwtUser,
  ): Promise<SiteDto> {
    await this.assertSiteAccess(siteId, user);

    await this.siteRepository
      .createQueryBuilder()
      .relation(Site, 'agents')
      .of(siteId)
      .remove(agentId);

    return this.findOne(siteId);
  }

  // ── Access-policy helpers ──
  private canAccessSite(site: Site, user: JwtUser): boolean {
    if (
      this.isSuperAdmin(user) ||
      this.isAdminOfSite(site, user) ||
      site.ownerId === user.id
    ) {
      return true;
    }
    if (user.role === UserRole.AGENT) {
      return site.agents.some((agent) => agent.id === user.id);
    }
    return false;
  }

  private isSuperAdmin(user: JwtUser): boolean {
    return user.role === UserRole.SUPER_ADMIN;
  }

  private isAdminOfSite(site: Site, user: JwtUser): boolean {
    return (
      user.role === UserRole.ADMIN &&
      user.organizationId !== null &&
      site.organizationId === user.organizationId
    );
  }

  private sanitizeAllowedDomains(domains?: string[]): string[] {
    if (!domains || !Array.isArray(domains)) return [];

    const cleaned = domains
      .map((domain) => {
        let clean = domain.trim();
        try {
          if (clean.startsWith('http://') || clean.startsWith('https://')) {
            clean = new URL(clean).hostname;
          }
        } catch {
          // Ignore invalid URLs
        }
        clean = clean.replace(/\/$/, '');
        clean = clean.split(':')[0];

        return clean;
      })
      .filter(Boolean);

    return Array.from(new Set(cleaned));
  }

  // ── Upload Image ──
  async uploadImage(
    siteId: string,
    file: Express.Multer.File,
    user: JwtUser,
  ): Promise<UploadApiResponse> {
    await this.assertSiteAccess(siteId, user);

    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: `sites/${siteId}` },
        (error, result) => {
          if (result) {
            resolve(result);
          } else {
            reject(new Error(error?.message || 'Cloudinary upload failed'));
          }
        },
      );
      stream.end(file.buffer);
    });
  }

  // ── BYOK — Bring Your Own Key (SEC-001 / CE-004) ──────────────────────────

  /**
   * Save a custom API key for a site (BYOK).
   * Validates the key via probe call against provider endpoints (DEEPSEEK_BASE_URL / OPENAI_BASE_URL).
   * The key is encrypted with AES-256-GCM before being stored in the DB.
   *
   * @param siteId    The target site
   * @param user      The requesting user (must have access to the site)
   * @param plainKey  The raw API key
   */
  /**
   * Safe helper to extract status code and message from unknown caught errors.
   */
  private extractErrorDetails(err: unknown): {
    status?: number;
    message: string;
  } {
    if (err instanceof Error) {
      const errObj = err as unknown as Record<string, unknown>;
      const status =
        typeof errObj.status === 'number'
          ? errObj.status
          : typeof errObj.statusCode === 'number'
            ? errObj.statusCode
            : undefined;
      return { status, message: err.message };
    }
    if (typeof err === 'object' && err !== null) {
      const obj = err as Record<string, unknown>;
      const status =
        typeof obj.status === 'number'
          ? obj.status
          : typeof obj.statusCode === 'number'
            ? obj.statusCode
            : undefined;
      const message =
        typeof obj.message === 'string'
          ? obj.message
          : typeof obj.error === 'string'
            ? obj.error
            : 'Unknown provider error';
      return { status, message };
    }
    return { message: typeof err === 'string' ? err : 'Unknown error' };
  }

  /**
   * Helper to generate a safe masked string for API key display (e.g. "sk-proj-••••...3a9b").
   */
  private generateKeyMask(key: string): string {
    const trimmed = key.trim();
    if (trimmed.length <= 8) {
      return '••••' + trimmed.slice(-4);
    }
    const prefix = trimmed.startsWith('sk-proj-')
      ? 'sk-proj-'
      : trimmed.startsWith('sk-')
        ? 'sk-'
        : trimmed.slice(0, 4);
    const suffix = trimmed.slice(-4);
    return `${prefix}••••...${suffix}`;
  }

  /**
   * Save a custom API key for a site (BYOK).
   * Validates the key and candidate model via probe chat completion against provider endpoints (customBaseUrl / DEEPSEEK_BASE_URL / OPENAI_BASE_URL).
   * If plainKey is omitted, validates and uses the site's existing stored key.
   * The key is encrypted with AES-256-GCM before being stored in the DB.
   *
   * @param siteId         The target site
   * @param user           The requesting user (must have access to the site)
   * @param plainKey       The raw API key (optional if site already has custom key stored)
   * @param customBaseUrl  Optional custom provider URL (e.g. https://api.openai.com/v1)
   * @param llmModel       Optional model name (e.g. gpt-4o-mini, qwen3.7-flash)
   */
  async saveCustomApiKey(
    siteId: string,
    user: JwtUser,
    plainKey?: string | null,
    customBaseUrl?: string | null,
    llmModel?: string | null,
  ): Promise<{
    useCustomOpenAiKey: boolean;
    customKeyStatus: 'unknown' | 'valid' | 'invalid';
    customBaseUrl?: string | null;
    keyMask?: string | null;
    llmModel?: string;
    warning?: string;
  }> {
    const site = await this.assertSiteAccess(siteId, user);

    let trimmedKey: string;
    let isNewKey = false;

    if (plainKey && plainKey.trim()) {
      trimmedKey = plainKey.trim();
      isNewKey = true;
    } else {
      if (!site.encryptedOpenAiKey) {
        throw new BadRequestException('API key must not be empty');
      }
      trimmedKey = decryptApiKey(site.encryptedOpenAiKey);
    }

    const cleanBaseUrl = customBaseUrl?.trim() || null;
    const cleanModel = llmModel?.trim() || null;
    const targetModel = cleanModel || site.llmModel || 'qwen3.7-flash';

    // Resolve candidate base URLs in priority order based on input and env:
    const candidateBaseUrls: string[] = [
      cleanBaseUrl,
      site.customBaseUrl,
      process.env.DEEPSEEK_BASE_URL,
      process.env.OPENAI_BASE_URL,
      'https://api.openai.com/v1',
    ].filter((url): url is string => Boolean(url && url.trim()));

    const uniqueBaseUrls = Array.from(new Set(candidateBaseUrls));

    let customKeyStatus: 'unknown' | 'valid' | 'invalid' = 'unknown';
    let warning: string | undefined;
    let lastError: { status?: number; message: string } | null = null;
    let verifiedSuccessfully = false;

    // Probe candidate endpoints with the provided key and model
    for (const baseUrl of uniqueBaseUrls) {
      const probeClient = new OpenAI({
        apiKey: trimmedKey,
        baseURL: baseUrl,
        timeout: 8000,
        maxRetries: 0,
      });

      try {
        await probeClient.chat.completions.create({
          model: targetModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        });
        customKeyStatus = 'valid';
        verifiedSuccessfully = true;
        this.logger.log(
          `Custom API key & model (${targetModel}) verified successfully for site ${siteId} via ${baseUrl}`,
        );
        break;
      } catch (err: unknown) {
        const { status, message: errMsg } = this.extractErrorDetails(err);
        lastError = { status, message: errMsg };

        const isQuotaOrRateLimit =
          status === 429 ||
          errMsg.includes('429') ||
          errMsg.includes('insufficient_quota') ||
          errMsg.includes('rate_limit') ||
          errMsg.includes('Rate limit');

        if (isQuotaOrRateLimit) {
          customKeyStatus = 'valid';
          verifiedSuccessfully = true;
          warning =
            'API key is valid, but currently rate-limited or out of quota.';
          this.logger.warn(
            `Custom API key for site ${siteId} authenticated with quota/rate warning on ${baseUrl}: ${errMsg}`,
          );
          break;
        }

        const isModelError =
          status === 404 ||
          (status === 400 &&
            (errMsg.toLowerCase().includes('model') ||
              errMsg.toLowerCase().includes('not found') ||
              errMsg.toLowerCase().includes('does not exist') ||
              errMsg.toLowerCase().includes('invalid_request_error') ||
              errMsg.toLowerCase().includes('unsupported')));

        if (isModelError) {
          this.logger.warn(
            `Model validation failed for site ${siteId} on ${baseUrl} with model '${targetModel}': ${errMsg}`,
          );
          throw new BadRequestException(
            `Model '${targetModel}' is not found or not supported by this provider: ${errMsg.slice(0, 150)}`,
          );
        }
      }
    }

    if (!verifiedSuccessfully && lastError) {
      const { status, message: errMsg } = lastError;

      const isAuthError =
        status === 401 ||
        status === 403 ||
        errMsg.includes('401') ||
        errMsg.includes('403') ||
        errMsg.includes('Incorrect API key') ||
        errMsg.includes('invalid_api_key') ||
        errMsg.includes('Unauthorized') ||
        errMsg.includes('Authentication');

      if (isAuthError) {
        this.logger.warn(
          `Custom API key validation failed across provider endpoints for site ${siteId}: ${errMsg}`,
        );
        throw new BadRequestException(
          `API key is invalid or unauthorized: ${errMsg.slice(0, 150)}`,
        );
      } else {
        customKeyStatus = 'unknown';
        warning =
          'API credentials saved, but provider verification endpoint could not be reached within timeout.';
        this.logger.warn(
          `Could not reach provider probe endpoint for site ${siteId} (${errMsg}). Saved with status 'unknown'.`,
        );
      }
    }

    const encrypted = isNewKey ? encryptApiKey(trimmedKey) : undefined;
    const keyMask = isNewKey
      ? this.generateKeyMask(trimmedKey)
      : site.keyMask || null;

    await this.siteRepository.update(siteId, {
      ...(isNewKey ? { encryptedOpenAiKey: encrypted, keyMask } : {}),
      useCustomOpenAiKey: true,
      customKeyStatus,
      customBaseUrl: cleanBaseUrl,
      ...(cleanModel ? { llmModel: cleanModel } : {}),
    });

    this.logger.log(
      `Custom API key saved for site ${siteId} by user ${user.id} with status ${customKeyStatus}`,
    );
    return {
      useCustomOpenAiKey: true,
      customKeyStatus,
      customBaseUrl: cleanBaseUrl,
      keyMask,
      llmModel: cleanModel || site.llmModel || undefined,
      warning,
    };
  }

  /**
   * Test connection to AI provider on-demand without altering saved credentials.
   * If apiKey is supplied in candidateData, tests that key.
   * If apiKey is omitted, tests the site's currently stored and decrypted custom key.
   */
  async testCustomApiKeyConnection(
    siteId: string,
    user: JwtUser,
    candidateData?: {
      apiKey?: string;
      customBaseUrl?: string;
      llmModel?: string;
    },
  ): Promise<{
    valid: boolean;
    latencyMs: number;
    customKeyStatus: 'valid' | 'invalid' | 'unknown';
    endpointTested: string;
    warning?: string;
    error?: string;
  }> {
    const site = await this.assertSiteAccess(siteId, user);

    let testKey = candidateData?.apiKey?.trim();
    if (!testKey) {
      if (!site.encryptedOpenAiKey) {
        throw new BadRequestException(
          'No custom API key configured for this site to test.',
        );
      }
      testKey = decryptApiKey(site.encryptedOpenAiKey);
    }

    const targetBaseUrl =
      candidateData?.customBaseUrl?.trim() ||
      site.customBaseUrl ||
      process.env.DEEPSEEK_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1';

    const targetModel =
      candidateData?.llmModel?.trim() || site.llmModel || 'qwen3.7-flash';

    const probeClient = new OpenAI({
      apiKey: testKey,
      baseURL: targetBaseUrl,
      timeout: 10000,
      maxRetries: 0,
    });

    const startTime = Date.now();
    try {
      await probeClient.chat.completions.create({
        model: targetModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      const latencyMs = Date.now() - startTime;

      if (!candidateData?.apiKey && site.encryptedOpenAiKey) {
        void this.siteRepository.update(siteId, { customKeyStatus: 'valid' });
      }

      return {
        valid: true,
        latencyMs,
        customKeyStatus: 'valid',
        endpointTested: `${targetBaseUrl} (model: ${targetModel})`,
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - startTime;
      const { status, message: errMsg } = this.extractErrorDetails(err);

      const isQuotaOrRateLimit =
        status === 429 ||
        errMsg.includes('429') ||
        errMsg.includes('insufficient_quota') ||
        errMsg.includes('rate_limit') ||
        errMsg.includes('Rate limit');

      if (isQuotaOrRateLimit) {
        return {
          valid: true,
          latencyMs,
          customKeyStatus: 'valid',
          endpointTested: `${targetBaseUrl} (model: ${targetModel})`,
          warning: 'Key is valid, but currently rate-limited or out of quota.',
        };
      }

      const isModelError =
        status === 404 ||
        (status === 400 &&
          (errMsg.toLowerCase().includes('model') ||
            errMsg.toLowerCase().includes('not found') ||
            errMsg.toLowerCase().includes('does not exist') ||
            errMsg.toLowerCase().includes('invalid_request_error') ||
            errMsg.toLowerCase().includes('unsupported')));

      if (isModelError) {
        if (!candidateData?.apiKey && site.encryptedOpenAiKey) {
          void this.siteRepository.update(siteId, {
            customKeyStatus: 'invalid',
          });
        }
        return {
          valid: false,
          latencyMs,
          customKeyStatus: 'invalid',
          endpointTested: targetBaseUrl,
          error: `Model '${targetModel}' not found or not supported: ${errMsg.slice(0, 150)}`,
        };
      }

      const isAuthError =
        status === 401 ||
        status === 403 ||
        errMsg.includes('401') ||
        errMsg.includes('403') ||
        errMsg.includes('Incorrect API key') ||
        errMsg.includes('invalid_api_key') ||
        errMsg.includes('Unauthorized') ||
        errMsg.includes('Authentication');

      if (isAuthError) {
        if (!candidateData?.apiKey && site.encryptedOpenAiKey) {
          void this.siteRepository.update(siteId, {
            customKeyStatus: 'invalid',
          });
        }
        return {
          valid: false,
          latencyMs,
          customKeyStatus: 'invalid',
          endpointTested: targetBaseUrl,
          error: `Unauthorized or invalid API key: ${errMsg.slice(0, 150)}`,
        };
      }

      return {
        valid: false,
        latencyMs,
        customKeyStatus: 'unknown',
        endpointTested: targetBaseUrl,
        error: `Connection error or timeout (${errMsg.slice(0, 150)})`,
      };
    }
  }

  /**
   * Remove the custom OpenAI API key for a site, reverting to the master env key.
   *
   * @param siteId  The target site
   * @param user    The requesting user (must have access to the site)
   */
  async removeCustomApiKey(
    siteId: string,
    user: JwtUser,
  ): Promise<{ useCustomOpenAiKey: boolean; customKeyStatus: 'unknown' }> {
    await this.assertSiteAccess(siteId, user);

    await this.siteRepository.update(siteId, {
      encryptedOpenAiKey: null,
      useCustomOpenAiKey: false,
      customKeyStatus: 'unknown',
      customBaseUrl: null,
      keyMask: null,
    });

    this.logger.log(
      `Custom OpenAI key removed for site ${siteId} by user ${user.id}`,
    );
    return { useCustomOpenAiKey: false, customKeyStatus: 'unknown' };
  }

  /**
   * Retrieve and decrypt the custom OpenAI key for a site.
   * Used ONLY by the AI proxy layer (never returned to clients).
   *
   * @param site  The site entity with encryptedOpenAiKey
   * @returns     Plaintext API key, or null if not using a custom key
   */
  getDecryptedApiKey(site: {
    useCustomOpenAiKey: boolean;
    encryptedOpenAiKey: string | null;
  }): string | null {
    if (!site.useCustomOpenAiKey || !site.encryptedOpenAiKey) {
      return null;
    }
    try {
      return decryptApiKey(site.encryptedOpenAiKey);
    } catch (err) {
      this.logger.error(
        `Failed to decrypt API key for site: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
