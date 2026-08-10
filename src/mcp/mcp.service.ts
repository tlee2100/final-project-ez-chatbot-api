import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
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
} from './types/mcp.types';

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
   * @param topK - Maximum number of chunks to return. Defaults to 4.
   * @param minSimilarity - Minimum cosine similarity threshold. Defaults to 0.5.
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
      topK,
      minSimilarity,
    });

    return {
      chunks: results.map((item) => ({
        content: item.content,
        documentId: item.documentId,
        filename: item.filename,
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
      where: { siteId, status: DocumentStatus.READY },
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
  getAvailableSlots(
    siteId: string,
    date: string,
    resourceId?: string,
  ): AvailableSlot[] {
    this.logger.log(
      `[MCP] getAvailableSlots (MOCK): siteId=${siteId}, date=${date}, resourceId=${resourceId ?? 'any'}`,
    );

    const baseSlots = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'];
    return baseSlots.map((time, idx) => ({
      slotId: `mock-slot-${date}-${idx}`,
      date,
      timeSlot: time,
      resourceId: resourceId ?? 'mock-resource-001',
      resourceName: 'Stylist Lan (Mock)',
      available: true,
    }));
  }

  /**
   * MCP-007 / createBooking backend:
   * Creates a booking and returns a booking code.
   *
   * ponytail: MOCK — real implementation (with conflict detection) wired in Phase 1C.
   */
  createBooking(siteId: string, payload: CreateBookingPayload): BookingResult {
    this.logger.log(
      `[MCP] createBooking (MOCK): siteId=${siteId}, customer=${payload.customerName}, date=${payload.date}, time=${payload.timeSlot}`,
    );

    const bookingCode = `MOCK-${Date.now().toString(36).toUpperCase()}`;
    return {
      bookingCode,
      status: 'confirmed',
      customerName: payload.customerName,
      date: payload.date,
      timeSlot: payload.timeSlot,
      resourceName: 'Stylist Lan (Mock)',
      serviceId: payload.serviceId,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * MCP-008 / cancelBooking backend:
   * Cancels a booking by booking code.
   *
   * ponytail: MOCK — real implementation wired in Phase 1C.
   * Required Phase 1B deliverable: must be demonstrable via MCP Inspector.
   */
  cancelBooking(
    siteId: string,
    bookingCode: string,
  ): Pick<BookingResult, 'bookingCode' | 'status'> {
    this.logger.log(
      `[MCP] cancelBooking (MOCK): siteId=${siteId}, bookingCode=${bookingCode}`,
    );

    return { bookingCode, status: 'cancelled' };
  }
}
