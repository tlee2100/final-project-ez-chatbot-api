import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { type PaginateQuery, type Paginated, paginate } from 'nestjs-paginate';
import type { Mapper } from '@automapper/core';
import { InjectMapper } from '@automapper/nestjs';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';

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

type PaginatedSiteDtos = Omit<Paginated<Site>, 'data'> & {
  data: SiteDto[];
};

@Injectable()
export class SiteService {
  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectMapper()
    private readonly mapper: Mapper,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => ChatTimeoutService))
    private readonly chatTimeoutService: ChatTimeoutService,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
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
      const activeChatsRows = await this.siteRepository.manager.query<
        Array<{ siteId: string; count: string }>
      >(
        `SELECT "siteId", COUNT(id) as count FROM conversations WHERE "siteId" = ANY($1) AND status != 'CLOSED' GROUP BY "siteId"`,
        [siteIds],
      );
      activeChatsRows.forEach((row: { siteId: string; count: string }) => {
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

    const activeChatsRows = await this.siteRepository.manager.query<
      Array<{ count: string }>
    >(
      `SELECT COUNT(id) as count FROM conversations WHERE "siteId" = $1 AND status != 'CLOSED'`,
      [id],
    );
    dto.activeChats = parseInt(activeChatsRows[0]?.count || '0', 10);
    dto.updatedAt = new Date().toISOString();

    return dto;
  }

  // ── Find One Site Dto (Access-checked) ──
  async findOneWithAccess(id: string, user: JwtUser): Promise<SiteDto> {
    const site = await this.assertSiteAccess(id, user);
    const dto = this.mapper.map(site, Site, SiteDto);

    const activeChatsRows = await this.siteRepository.manager.query<
      Array<{ count: string }>
    >(
      `SELECT COUNT(id) as count FROM conversations WHERE "siteId" = $1 AND status != 'CLOSED'`,
      [id],
    );
    dto.activeChats = parseInt(activeChatsRows[0]?.count || '0', 10);
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
    if (conversations.length > 0) {
      const conversationIds = conversations.map((c) => c.id);
      this.chatGateway.broadcastSiteSettingsUpdated(
        conversationIds,
        updatedSite,
      );
    }

    return updatedSite;
  }

  // ── Delete Site ──
  async remove(id: string, user: JwtUser): Promise<void> {
    await this.assertSiteAccess(id, user);

    try {
      await this.siteRepository.manager.transaction(async (manager) => {
        // 1. Delete notifications related to the site directly
        await manager.query(`DELETE FROM "notifications" WHERE "siteId" = $1`, [
          id,
        ]);

        // 2. Delete conversations, their messages, and their notifications
        const conversations: Array<{ id: string }> = await manager.query(
          `SELECT id FROM "conversations" WHERE "siteId" = $1`,
          [id],
        );
        if (conversations.length > 0) {
          const conversationIds = conversations.map((c) => c.id);
          await manager.query(
            `DELETE FROM "notifications" WHERE "conversationId" = ANY($1)`,
            [conversationIds],
          );
          await manager.query(
            `DELETE FROM "chat_messages" WHERE "conversationId" = ANY($1)`,
            [conversationIds],
          );
          await manager.query(
            `DELETE FROM "conversations" WHERE "siteId" = $1`,
            [id],
          );
        }

        // 3. Delete documents and their chunks
        const documents: Array<{ id: string }> = await manager.query(
          `SELECT id FROM "documents" WHERE "siteId" = $1`,
          [id],
        );
        if (documents.length > 0) {
          const documentIds = documents.map((d) => d.id);
          await manager.query(
            `DELETE FROM "document_chunks" WHERE "documentId" = ANY($1)`,
            [documentIds],
          );
          await manager.query(`DELETE FROM "documents" WHERE "siteId" = $1`, [
            id,
          ]);
        }

        // 4. Clean up many-to-many agent assignments
        await manager.query(`DELETE FROM "site_agents" WHERE "siteId" = $1`, [
          id,
        ]);

        // 5. Delete the site
        await manager.delete(Site, id);
      });
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

    return domains
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
  }

  async hasActiveBookingsForService(
    siteId: string,
    serviceId: string,
  ): Promise<boolean> {
    const count = await this.bookingRepository.count({
      where: {
        siteId,
        serviceId,
        status: Not(In([BookingStatus.COMPLETED, BookingStatus.CANCELLED])),
      },
    });
    return count > 0;
  }

  async hasActiveBookingsForResource(
    siteId: string,
    resourceId: string,
  ): Promise<boolean> {
    const count = await this.bookingRepository.count({
      where: {
        siteId,
        resourceId,
        status: Not(In([BookingStatus.COMPLETED, BookingStatus.CANCELLED])),
      },
    });
    return count > 0;
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
}
