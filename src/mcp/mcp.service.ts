import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
   * Returns non-sensitive user profile details by email.
   */
  async getUserDetails(siteId: string, email: string) {
    this.logger.log(`[MCP] getUserDetails: siteId=${siteId}, email=${email}`);

    const user = await this.userRepository.findOne({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        avatarUrl: true,
      },
    });

    if (!user) {
      return {
        email,
        name: 'Guest Visitor',
        role: 'VISITOR',
        phone: null,
      };
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      avatarUrl: user.avatarUrl,
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
    });

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

    if (!site) {
      return {
        siteId,
        name: 'Default Site',
        url: 'http://localhost',
        isAiActive: true,
        knowledgeBaseStatus: 'READY',
        allowedDomains: ['*'],
        bookingEnabled: true,
        timezone: 'Asia/Ho_Chi_Minh',
        bookingHours,
        services,
        resources,
      };
    }

    return {
      siteId: site.id,
      name: site.name,
      url: site.url,
      isAiActive: site.isAiActive,
      knowledgeBaseStatus: site.knowledgeBaseStatus,
      allowedDomains: site.allowedDomains,
      bookingEnabled: true,
      timezone: 'Asia/Ho_Chi_Minh',
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

  /**
   * MCP-006 / getAvailableSlots backend:
   * Returns mock available time slots for a date and optional resource.
   *
   * ponytail: MOCK — real implementation wired in Phase 1C by BookingModule team.
   */
  async getAvailableSlots(
    siteId: string,
    date: string,
    resourceId?: string,
    serviceId?: string,
  ): Promise<AvailableSlot[]> {
    this.logger.log(
      `[MCP] getAvailableSlots: siteId=${siteId}, date=${date}, resourceId=${resourceId ?? 'any'}, serviceId=${serviceId ?? 'any'}`,
    );

    const config = await this.bookingService.getSiteBookingConfig(siteId);
    const timezone = config.bookingTimezone || 'UTC';

    const result = await this.bookingService.getAvailableSlots(
      siteId,
      resourceId || null,
      serviceId || null,
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
      const slotId = `slot-${date}-${idx}`;

      // Branch B: No Preference — slot has availableResources
      if ('availableResources' in slot && slot.availableResources) {
        return {
          slotId,
          date,
          timeSlot: localTime,
          availableResources: slot.availableResources,
          available: slot.availableResources.length > 0,
        };
      }

      // Branch A: Specific resource selected
      const s = slot as { startAt: string; endAt: string; resourceId: string };
      return {
        slotId,
        date,
        timeSlot: localTime,
        resourceId: s.resourceId ?? resourceId ?? 'any',
        resourceName: s.resourceId ? undefined : 'Any Provider', // will not happen in Branch A
        available: true,
      };
    });
  }

  /**
   * MCP-007 / createBooking backend:
   * Creates a booking and returns a booking code.
   *
   * ponytail: MOCK — real implementation (with conflict detection) wired in Phase 1C.
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

    if (!payload.resourceId) {
      throw new BadRequestException(
        'A specific staff/resource must be selected before creating a booking.',
      );
    }

    let resourceName = 'Staff';
    const resource = await this.bookingService.getResourceById(
      siteId,
      payload.resourceId,
    );
    if (resource) {
      resourceName = resource.name;
    }

    let serviceName = 'Service';
    if (payload.serviceId) {
      const service = await this.bookingService.getServiceById(
        siteId,
        payload.serviceId,
      );
      if (service) {
        serviceName = service.name;
      }
    }

    // Convert local date + timeSlot into UTC startAt / endAt
    const localDateTimeStr = `${payload.date}T${payload.timeSlot}:00`;
    const utcStartAt = fromZonedTime(localDateTimeStr, timezone);
    const utcEndAt = addMinutes(utcStartAt, duration);

    const sessionId = randomUUID();

    // Must hold the slot first since createBooking strictly validates it
    await this.bookingService.holdSlot(siteId, {
      resourceId: payload.resourceId,
      serviceId: payload.serviceId,
      startAt: utcStartAt.toISOString(),
      endAt: utcEndAt.toISOString(),
      sessionId,
    });

    const booking = await this.bookingService.createBooking({
      siteId,
      resourceId: payload.resourceId,
      serviceId: payload.serviceId,
      startAt: utcStartAt.toISOString(),
      endAt: utcEndAt.toISOString(),
      timezone,
      customerName: payload.customerName,
      phone: normalizePhoneNumber(payload.phone),
      customerEmail: payload.customerEmail,
      templateFields: {},
      sessionId,
    });

    return {
      bookingCode: booking.code,
      status: 'confirmed',
      customerName: booking.customerName,
      customerEmail: booking.customerEmail || payload.customerEmail,
      phone: booking.phone,
      date: payload.date,
      timeSlot: payload.timeSlot,
      resourceName,
      serviceId: payload.serviceId,
      serviceName,
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
