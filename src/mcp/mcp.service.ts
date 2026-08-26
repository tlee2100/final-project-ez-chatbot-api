import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Document } from '../document/entities/document.entity';
import { DocumentStatus } from '../document/enums/document-status.enum';
import { KnowledgeRetrievalService } from '../document/retrieval/knowledge-retrieval.service';
import { Conversation } from '../chat/entities/conversation.entity';
import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import type {
  McpValidatedContext,
  AvailableSlot,
  BookingResult,
  CreateBookingPayload,
  McpUserDetailsResult,
  SiteConfigBookingHours,
  SiteConfigResourceItem,
  SiteConfigServiceItem,
} from './types/mcp.types';
import { BookingService } from '../booking/booking.service';
import { normalizePhoneNumber } from '../chat/chat-flow.utils';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { addMinutes } from 'date-fns';

/**
 * MCP-002, MCP-003: Service backing all /api/internal/mcp/* endpoints.
 *
 * Knowledge methods:
 *  - searchKnowledge: delegates to KnowledgeRetrievalService (PR #66) for
 *    real vector similarity search via pgvector (Decision 1: Option C Adapter).
 *  - listDocuments: queries Document repository directly (read-only listing).
 *
 * Booking methods return MOCK data per Rule 3 (Phase 1B) until Phase 1C
 * BookingModule is implemented and injected here.
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly jwtService: JwtService,
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    private readonly knowledgeRetrievalService: KnowledgeRetrievalService,
    private readonly bookingService: BookingService,
  ) {}

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /**
   * Validates the Bearer access token sent by the MCP Client and returns the
   * validated context (siteId, conversationId, authorizedActor).
   * Called by the MCP server's api-client.ts `validateAccessToken` on every
   * incoming connection.
   */
  validateToken(accessToken: string): McpValidatedContext {
    try {
      const payload = this.jwtService.verify<{
        sub: number;
        siteId: string;
        conversationId: string;
        exp?: number;
      }>(accessToken, {
        secret: process.env.JWT_SECRET,
      });

      return {
        siteId: payload.siteId,
        conversationId: payload.conversationId,
        authorizedActor: {
          type: 'service',
          id: payload.sub,
        },
        expiresAt: payload.exp,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired MCP session token.');
    }
  }

  /**
   * MCP / getConversationContext backend:
   * Returns details for a conversation context.
   */
  async getConversationContext(siteId: string, conversationId: string) {
    this.logger.log(
      `[MCP] getConversationContext: siteId=${siteId}, conversationId=${conversationId}`,
    );

    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId, siteId },
      relations: { messages: true },
    });

    if (!conversation) {
      return {
        visitorDisplayName: 'Guest Visitor',
        status: 'OPEN',
        handoffState: 'AI_HANDLING',
        summary: null,
        messages: [],
      };
    }

    return {
      visitorDisplayName: conversation.visitorName || 'Guest Visitor',
      status: conversation.status,
      handoffState: conversation.handlingStatus,
      summary: conversation.summary,
      messages: (conversation.messages || []).map((msg) => ({
        role: msg.senderType,
        timestamp: msg.createdAt,
        content: msg.content,
      })),
    };
  }

  /**
   * MCP / getUserDetails backend:
   * Returns non-sensitive user profile details by email, scoped to the given siteId.
   * Returns null if the user does not belong to the site.
   *
   * A user belongs to a site if they are:
   * (A) the site owner  (site.ownerId = user.id)
   * (B) an assigned agent (site_agents join table)
   * (C) in the same organization (user.organizationId = site.organizationId)
   */
  async getUserDetails(
    siteId: string,
    email: string,
  ): Promise<McpUserDetailsResult | null> {
    this.logger.log({
      event: 'mcp_get_user_details',
      siteId,
      emailDomain: email.split('@')[1] ?? 'unknown',
    });

    const user = await this.userRepository
      .createQueryBuilder('user')
      .innerJoin('sites', 'site', 'site.id = :siteId', { siteId })
      .leftJoin(
        'site_agents',
        'sa',
        'sa."agentId" = user.id AND sa."siteId" = :siteId',
        { siteId },
      )
      .where('user.email = :email', { email })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('user.id = site."ownerId"')
            .orWhere('sa."agentId" IS NOT NULL')
            .orWhere(
              'user."organizationId" IS NOT NULL AND user."organizationId" = site."organizationId"',
            ),
        ),
      )
      .select([
        'user.id',
        'user.name',
        'user.email',
        'user.phone',
        'user.role',
        'user.avatarUrl',
      ])
      .getOne();

    if (!user) {
      return null;
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone ?? null,
      role: user.role,
      avatarUrl: user.avatarUrl ?? null,
    };
  }

  /**
   * MCP / getSiteConfig backend:
   * Returns current site settings for a site.
   */
  async getSiteConfig(siteId: string) {
    this.logger.log(`[MCP] getSiteConfig: siteId=${siteId}`);

    const site = await this.siteRepository.findOne({
      where: { id: siteId },
      relations: { industryTemplateInfo: true },
    });

    if (!site) {
      throw new NotFoundException(`Site with ID ${siteId} not found`);
    }

    let bookingHours: SiteConfigBookingHours = {};
    let services: SiteConfigServiceItem[] = [];
    let resources: SiteConfigResourceItem[] = [];
    try {
      const config = await this.bookingService.getSiteBookingConfig(siteId);
      const dbServices = await this.bookingService.getServicesBySiteId(siteId);
      const dbResources =
        await this.bookingService.getResourcesBySiteId(siteId);
      bookingHours = {
        timezone: config.bookingTimezone,
        availableDays: config.bookingAvailableDays,
        startTime: config.bookingStartTime,
        endTime: config.bookingEndTime,
        slotDuration: config.bookingSlotDuration,
      };
      services = dbServices.map((s) => ({
        id: s.id,
        name: s.name,
      }));
      resources = dbResources.map((r) => ({
        id: r.id,
        name: r.name,
      }));
      this.logger.log(
        `[MCP] getSiteConfig loaded services=${services.length}, resources=${resources.length}`,
      );
    } catch {
      this.logger.warn(`Failed to fetch booking config for site ${siteId}`);
    }

    return {
      siteId: site.id,
      name: site.name,
      url: site.url,
      isAiActive: site.isAiActive,
      knowledgeBaseStatus: site.knowledgeBaseStatus,
      allowedDomains: site.allowedDomains,
      bookingEnabled: site.bookingEnabled ?? true,
      industryTemplate: site.industryTemplateId || 'salon',
      industryTemplateConfig: site.industryTemplateInfo?.config ?? null,
      timezone: bookingHours.timezone || 'Asia/Ho_Chi_Minh',
      bookingHours,
      services,
      resources,
    };
  }

  // ─── Knowledge (RAG) ──────────────────────────────────────────────────────

  /**
   * MCP-004 / searchKnowledge backend:
   * Executes real vector similarity search using KnowledgeRetrievalService
   * from DocumentModule (PR #66 — Option C Adapter, Decision 1).
   *
   * Flow:
   *  1. KnowledgeRetrievalService.searchRelevantChunks() embeds the query
   *     via EmbeddingService.embedOne() (OpenAI text-embedding-3-small).
   *  2. Runs pgvector cosine similarity search on document_chunks for the site.
   *  3. Filters by minSimilarity threshold and returns top-K results.
   *
   * @param query - Natural language search query from the MCP tool consumer (LLM).
   * @param siteId - Tenant isolation — restricts search to this site's chunks.
   * @param topK - Deprecated compatibility input. Site settings take precedence.
   * @param minSimilarity - Deprecated compatibility input. Site settings take precedence.
   */
  async searchKnowledge(
    query: string,
    siteId: string,
    topK = 4,
    minSimilarity = 0.5,
  ): Promise<{
    chunks: {
      content: string;
      documentId: string;
      filename: string;
      sourceUrl: string | null;
      sectionTitle: string | null;
      similarity: number;
    }[];
  }> {
    this.logger.log(
      `[MCP] searchKnowledge: query="${query}", siteId=${siteId}, topK=${topK}, minSimilarity=${minSimilarity}`,
    );

    const results = await this.knowledgeRetrievalService.searchRelevantChunks({
      siteId,
      query,
    });

    return {
      chunks: results.map((item) => ({
        content: item.content,
        documentId: item.documentId,
        filename: item.filename,
        sourceUrl: item.sourceUrl ?? null,
        sectionTitle: item.sectionTitle,
        similarity: item.similarity,
      })),
    };
  }

  /**
   * MCP-005 / listDocuments backend:
   * Lists all KB documents for a site.
   */
  async listDocuments(
    siteId: string,
  ): Promise<
    { id: string; filename: string; status: string; uploadedAt: Date }[]
  > {
    this.logger.log(`[MCP] listDocuments: siteId=${siteId}`);

    const documents = await this.documentRepository.find({
      where: { siteId },
      order: { uploadedAt: 'DESC' },
      select: {
        id: true,
        filename: true,
        status: true,
        uploadedAt: true,
      },
    });

    return documents.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      status: doc.status,
      uploadedAt: doc.uploadedAt,
    }));
  }

  /**
   * MCP-006 / listDocuments with status filter backend:
   * Returns only READY documents for the site (used by legacy callers).
   */
  async listReadyDocuments(siteId: string): Promise<string[]> {
    const documents = await this.documentRepository.find({
      where: { siteId, status: DocumentStatus.READY, isActive: true },
      order: { processedAt: 'DESC' },
    });

    return documents.map((doc) => doc.filename);
  }

  // ─── Booking (Mocked — Phase 1B per Rule 3) ───────────────────────────────

  private async resolveResourceId(
    siteId: string,
    resourceIdOrName?: string,
  ): Promise<string | undefined> {
    if (!resourceIdOrName) return undefined;
    const resources = await this.bookingService.getResourcesBySiteId(siteId);
    const items = resourceIdOrName
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    const resolved = items.map((item) => {
      const matched = resources.find(
        (r) =>
          r.id === item ||
          r.name.toLowerCase().trim() === item.toLowerCase().trim(),
      );
      return matched ? matched.id : item;
    });

    return resolved.length > 0 ? resolved.join(',') : resourceIdOrName;
  }

  private async resolveServiceId(
    siteId: string,
    serviceIdOrName?: string,
  ): Promise<string | undefined> {
    if (!serviceIdOrName) return undefined;
    const services = await this.bookingService.getServicesBySiteId(siteId);
    const items = serviceIdOrName
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    const resolved = items.map((item) => {
      const matched = services.find(
        (s) =>
          s.id === item ||
          s.name.toLowerCase().trim() === item.toLowerCase().trim(),
      );
      return matched ? matched.id : item;
    });

    return resolved.length > 0 ? resolved.join(',') : serviceIdOrName;
  }

  /**
   * MCP-006 / getAvailableSlots backend:
   * Returns available time slots for a date and optional resource.
   */
  async getAvailableSlots(
    siteId: string,
    date: string,
    resourceId?: string,
    serviceId?: string,
  ): Promise<AvailableSlot[]> {
    const resolvedResourceId = await this.resolveResourceId(siteId, resourceId);
    const resolvedServiceId = await this.resolveServiceId(siteId, serviceId);

    this.logger.log(
      `[MCP] getAvailableSlots: siteId=${siteId}, date=${date}, resourceId=${resolvedResourceId ?? 'any'}, serviceId=${resolvedServiceId ?? 'any'}`,
    );

    const config = await this.bookingService.getSiteBookingConfig(siteId);
    const timezone = config.bookingTimezone || 'UTC';
    const allResources = await this.bookingService.getResourcesBySiteId(siteId);

    const result = await this.bookingService.getAvailableSlots(
      siteId,
      resolvedResourceId || null,
      resolvedServiceId || null,
      date, // startDate (ISO or local date string)
      date, // endDate (same day)
    );

    return result.slots.map((slot, idx) => {
      // slot.startAt is an ISO string in UTC
      const localTime = formatInTimeZone(
        new Date(slot.startAt),
        timezone,
        'HH:mm',
      );
      const slotDate = formatInTimeZone(
        new Date(slot.startAt),
        timezone,
        'yyyy-MM-dd',
      );
      const slotId = `slot-${slotDate}-${localTime}-${idx}`;

      // Branch B: No Preference — slot has availableResources
      if ('availableResources' in slot && slot.availableResources) {
        return {
          slotId,
          date: slotDate,
          timeSlot: localTime,
          availableResources: slot.availableResources,
          available: slot.availableResources.length > 0,
        };
      }

      // Branch A: Specific resource selected
      const s = slot as { startAt: string; endAt: string; resourceId: string };
      const matchedRes = allResources.find((r) => r.id === s.resourceId);
      return {
        slotId,
        date: slotDate,
        timeSlot: localTime,
        resourceId: s.resourceId ?? resolvedResourceId ?? 'any',
        resourceName: matchedRes?.name,
        available: true,
      };
    });
  }

  /**
   * MCP-009 / holdSlot backend:
   * Holds a slot.
   */
  async holdSlot(
    siteId: string,
    payload: {
      resourceId?: string;
      serviceId?: string;
      date?: string;
      timeSlot?: string;
      slotCount?: number;
      sessionId?: string;
      conversationId?: string;
      slots?: Array<{
        resourceId: string;
        date: string;
        timeSlot: string;
        serviceId?: string;
        notes?: string;
      }>;
    },
  ): Promise<{ sessionId: string }> {
    this.logger.log(
      `[MCP] holdSlot: siteId=${siteId}, resource=${payload.resourceId}, date=${payload.date}, time=${payload.timeSlot}, slotCount=${payload.slotCount ?? 1}`,
    );

    const config = await this.bookingService.getSiteBookingConfig(siteId);
    const timezone = config.bookingTimezone || 'UTC';
    const duration = config.bookingSlotDuration || 30;
    const sessionId =
      payload.sessionId || payload.conversationId || randomUUID();

    const slotsToHold: Array<{
      resourceId: string;
      startAt: string;
      endAt: string;
      serviceId?: string;
    }> = [];

    // Direct multi-slot list
    if (payload.slots && payload.slots.length > 0) {
      for (const slot of payload.slots) {
        const localStart = `${slot.date}T${slot.timeSlot}:00`;
        const utcStart = fromZonedTime(localStart, timezone);
        const utcEnd = addMinutes(utcStart, duration);
        slotsToHold.push({
          resourceId: slot.resourceId,
          startAt: utcStart.toISOString(),
          endAt: utcEnd.toISOString(),
          serviceId: slot.serviceId ?? payload.serviceId,
        });
      }
    } else if (payload.resourceId && payload.date && payload.timeSlot) {
      const slotCount = Math.max(1, payload.slotCount ?? 1);
      const localDateTimeStr = `${payload.date}T${payload.timeSlot}:00`;
      let currStart = fromZonedTime(localDateTimeStr, timezone);
      for (let i = 0; i < slotCount; i++) {
        const currEnd = addMinutes(currStart, duration);
        slotsToHold.push({
          resourceId: payload.resourceId,
          startAt: currStart.toISOString(),
          endAt: currEnd.toISOString(),
          serviceId: payload.serviceId,
        });
        currStart = currEnd;
      }
    }

    return this.bookingService.holdSlots(siteId, slotsToHold, sessionId);
  }

  /**
   * MCP-010 / releaseHold backend:
   * Releases a hold by reconstructing the holdKey and deleting it.
   */
  async releaseHold(
    siteId: string,
    payload: {
      resourceId?: string;
      date?: string;
      timeSlot?: string;
      slotCount?: number;
      sessionId?: string;
    },
  ): Promise<{ success: boolean }> {
    this.logger.log(
      `[MCP] releaseHold: siteId=${siteId}, resource=${payload.resourceId}, date=${payload.date}, time=${payload.timeSlot}, sessionId=${payload.sessionId}`,
    );

    if (payload.sessionId) {
      await this.bookingService.releaseSessionHolds(siteId, payload.sessionId);
    }

    if (payload.resourceId && payload.date && payload.timeSlot) {
      const config = await this.bookingService.getSiteBookingConfig(siteId);
      const timezone = config.bookingTimezone || 'UTC';
      const duration = config.bookingSlotDuration || 30;
      const slotCount = Math.max(1, payload.slotCount ?? 1);

      let currStart = fromZonedTime(
        `${payload.date}T${payload.timeSlot}:00`,
        timezone,
      );

      for (let i = 0; i < slotCount; i++) {
        const currEnd = addMinutes(currStart, duration);
        await this.bookingService.releaseHold(siteId, {
          resourceId: payload.resourceId,
          startAt: currStart.toISOString(),
          endAt: currEnd.toISOString(),
          sessionId: payload.sessionId || '',
        });
        currStart = currEnd;
      }
    }

    return { success: true };
  }

  /**
   * MCP-007 / createBooking backend:
   * Creates a booking and returns a booking code.
   */
  async createBooking(
    siteId: string,
    payload: CreateBookingPayload,
  ): Promise<BookingResult> {
    this.logger.log(
      `[MCP] createBooking: siteId=${siteId}, customer=${payload.customerName}, date=${payload.date}, time=${payload.timeSlot}`,
    );

    const config = await this.bookingService.getSiteBookingConfig(siteId);
    const timezone = config.bookingTimezone || 'UTC';
    const duration = config.bookingSlotDuration || 30;

    const rawResourceId = payload.resourceId || payload.slots?.[0]?.resourceId;

    const resolvedResourceId = rawResourceId
      ? (await this.resolveResourceId(siteId, rawResourceId)) || rawResourceId
      : undefined;

    if (!resolvedResourceId) {
      throw new BadRequestException(
        'A specific staff/resource must be selected before creating a booking.',
      );
    }

    let resourceName = 'Staff';
    const resource = await this.bookingService.getResourceById(
      siteId,
      resolvedResourceId,
    );
    if (resource) {
      resourceName = resource.name;
    }

    const cleanServiceId =
      payload.serviceId && payload.serviceId.trim()
        ? payload.serviceId.trim()
        : undefined;

    const resolvedServiceId = cleanServiceId
      ? await this.resolveServiceId(siteId, cleanServiceId)
      : undefined;

    const serviceNames: string[] = [];
    const allServiceIdsRaw = (
      Array.isArray(payload.serviceIds)
        ? payload.serviceIds
        : resolvedServiceId
          ? [resolvedServiceId]
          : []
    ).filter((s) => typeof s === 'string' && s.trim().length > 0);
    const resolvedAllServiceIds: string[] = [];

    for (const sId of allServiceIdsRaw) {
      const actualId = (await this.resolveServiceId(siteId, sId)) || sId;
      if (actualId && actualId.trim()) {
        resolvedAllServiceIds.push(actualId);
        const service = await this.bookingService.getServiceById(
          siteId,
          actualId,
        );
        if (service) {
          serviceNames.push(service.name);
        }
      }
    }

    const sanitizedSlots = payload.slots
      ? payload.slots.map((s) => {
          const slotCopy = { ...s };
          if (
            typeof slotCopy.serviceId === 'string' &&
            !slotCopy.serviceId.trim()
          ) {
            delete slotCopy.serviceId;
          }
          return slotCopy;
        })
      : undefined;

    const slotCount = Math.max(1, payload.slotCount ?? 1);
    const localDateTimeStr = `${payload.date}T${payload.timeSlot}:00`;
    const utcStartAt = fromZonedTime(localDateTimeStr, timezone);
    const utcEndAt = addMinutes(utcStartAt, duration * slotCount);

    let sessionId = payload.sessionId;

    const activeHold = await this.bookingService.getHold(
      siteId,
      resolvedResourceId,
      utcStartAt.toISOString(),
      addMinutes(utcStartAt, duration).toISOString(),
    );

    if (activeHold?.sessionId) {
      sessionId = activeHold.sessionId;
    } else {
      if (!sessionId) {
        sessionId = randomUUID();
      }
      await this.holdSlot(siteId, {
        resourceId: resolvedResourceId,
        serviceId: resolvedServiceId,
        date: payload.date,
        timeSlot: payload.timeSlot,
        slotCount,
        slots: sanitizedSlots,
        sessionId,
      });
    }

    const booking = await this.bookingService.createBooking({
      siteId,
      resourceId: resolvedResourceId,
      serviceId: resolvedServiceId || undefined,
      serviceIds:
        resolvedAllServiceIds.length > 0 ? resolvedAllServiceIds : undefined,
      slots: sanitizedSlots,
      startAt: utcStartAt.toISOString(),
      endAt: utcEndAt.toISOString(),
      timezone,
      customerName: payload.customerName,
      phone: normalizePhoneNumber(payload.phone),
      customerEmail: payload.customerEmail?.trim() || undefined,
      templateFields: {},
      sessionId,
    });

    const allBookingCodes = (booking.templateFields
      ?.allBookingCodes as string[]) || [booking.code];

    return {
      bookingCode: booking.code,
      allBookingCodes,
      status: 'confirmed',
      customerName: booking.customerName,
      customerEmail: booking.customerEmail || payload.customerEmail,
      phone: booking.phone,
      date:
        payload.date ||
        payload.slots?.[0]?.date ||
        formatInTimeZone(new Date(booking.startAt), timezone, 'yyyy-MM-dd'),
      timeSlot:
        payload.timeSlot ||
        payload.slots?.[0]?.timeSlot ||
        formatInTimeZone(new Date(booking.startAt), timezone, 'HH:mm'),
      endTimeSlot: formatInTimeZone(new Date(booking.endAt), timezone, 'HH:mm'),
      resourceName,
      serviceId: payload.serviceId,
      serviceIds: payload.serviceIds,
      serviceName: serviceNames[0],
      serviceNames,
      createdAt: booking.createdAt.toISOString(),
    };
  }

  /**
   * MCP-008 / cancelBooking backend:
   * Cancels a booking by booking code.
   *
   * ponytail: MOCK — real implementation wired in Phase 1C.
   * Required Phase 1B deliverable: must be demonstrable via MCP Inspector.
   */
  async cancelBooking(
    siteId: string,
    bookingCode: string,
  ): Promise<Pick<BookingResult, 'bookingCode' | 'status'>> {
    this.logger.log(
      `[MCP] cancelBooking: siteId=${siteId}, bookingCode=${bookingCode}`,
    );

    const booking = await this.bookingService.getBookingByCode(
      siteId,
      bookingCode,
    );
    await this.bookingService.cancelBooking(siteId, booking.id);

    return { bookingCode, status: 'cancelled' };
  }
}
