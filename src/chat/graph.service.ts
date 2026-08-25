import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  CancelFlowAction,
  CancelPrompts,
  CancelState,
  CancelStep,
  getAbandonBookingPrompt,
  getAbortChip,
  getBookingOptionPrompt,
  getCancelFlowClassifierPrompt,
  getCancelPrompts,
  getIntentClassifierPrompt,
  getKnowledgeFallbackPrompt,
  getKnowledgeGroundingRule,
  getOutOfScopePrompt,
  getPublicCapabilitiesPrompt,
  getSlotCardPrompt,
} from './prompts';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { formatInTimeZone } from 'date-fns-tz';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { BookingService } from '../booking/booking.service';
import { TOOL_PROVIDER } from './interfaces/tool-provider.interface';
import type {
  IToolProviderFactory,
  IToolProvider,
} from './interfaces/tool-provider.interface';
import type { LLMMessage } from './interfaces/llm-request.interface';
import { Conversation } from './entities/conversation.entity';
import {
  ChatMessage as ChatMessageEntity,
  SenderType,
} from './entities/chat-message.entity';
import { Site } from '../site/entities/site.entity';
import { ChatGateway } from './chat.gateway';
import { NotificationService } from '../notification/notification.service';
import {
  extractBookingCode,
  latestActiveBookingCode,
  extractPhoneFromText,
  normalizePhone,
} from './booking-cancellation.utils';
import {
  bookingCodeText,
  bookAppointmentToolNames,
  detectBookingTriggerLocale,
  detectSmallTalkLocale,
  enforceBookingChipScope,
  extractRequestedTimeSlot,
  isBookingAbandonment,
  isBookingFlowIntent,
  isBookingSlotSelection,
  isTimeSlotAvailable,
  parseBookingSlotSelection,
  parseKnowledgeSearchOutput,
  parseMultimodalContent,
  shouldContinueBookingFlow,
  stripReasoningContent,
  stripRenderedSlotTimes,
  type KnowledgeSearchStatus,
} from './chat-flow.utils';
import { AdminTestStreamDto } from './dto/admin-test-stream.dto';
import {
  DEFAULT_LOCALE,
  localeLanguage,
  normalizeLocale,
  resolveEffectiveLocale,
  UNDETERMINED_LOCALE,
} from './chat-locale.utils';
import {
  bookingOptionNeedsModel,
  buildChatMessageComponents,
  extractBookingCommandJson,
  hasActiveStructuredBookingProgress,
  parseBookingOptionSelection,
  stripModelBookingDirectives,
  type ChatMessageComponent,
} from './chat-message-components';
import { buildToolSchema } from './tool-schema.utils';
// ─── Agent State ──────────────────────────────────────────────────────────────

/** Intent categories the classifier node can assign */
type IntentType =
  | 'question'
  | 'system_question'
  | 'out_of_scope'
  | 'request_human'
  | 'small_talk'
  | 'book_appointment'
  | 'book_appointment_init'
  | 'structured_booking_step'
  | 'booking_slot_selected'
  | 'confirm_booking'
  | 'check_booking'
  | 'cancel_booking'
  | 'abort_cancel_flow'
  | 'abandon_booking'
  | null;

/**
 * AgentState — the shared state object threaded through the entire LangGraph workflow.
 *
 * Each field uses a reducer that defines how updates are merged:
 *  - messages: accumulated via concat (LangGraph default)
 *  - all others: replaced with the latest value (y wins over x)
 */
const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
  siteId: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  conversationId: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  intent: Annotation<IntentType>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  locale: Annotation<string>({
    reducer: (_, y) => y,
    default: () => DEFAULT_LOCALE,
  }),
  activeFlow: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  activeFlowLocale: Annotation<string | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  visitorContext: Annotation<{ name?: string; email?: string }>({
    reducer: (_, y) => y,
    default: () => ({}),
  }),
  siteContext: Annotation<{
    name?: string;
    domains?: string[];
    bookingEnabled?: boolean;
    humanHandoffEnabled?: boolean;
    bookingServices?: { id: string; name: string }[];
    bookingResources?: { id: string; name: string }[];
    bookingHours?: {
      timezone?: string | null;
      availableDays?: number[];
      startTime?: string;
      endTime?: string;
      slotDuration?: number;
    };
    industryTemplateId?: string;
    industryTemplateConfig?: Record<string, unknown>;
  }>({
    reducer: (_, y) => y,
    default: () => ({}),
  }),
  /** Knowledge source references extracted from tool responses */
  knowledgeSources: Annotation<
    { documentId: string; filename: string; sourceUrl?: string }[]
  >({
    reducer: (_, y) => y,
    default: () => [],
  }),
  knowledgeSearchStatus: Annotation<KnowledgeSearchStatus>({
    reducer: (_, y) => y,
    default: () => 'idle',
  }),
  /** Rolling conversation summary (loaded from DB at start of each run) */
  summary: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  summarizedMessageCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  cancelState: Annotation<CancelState>({
    reducer: (_, y) => y,
    default: () => ({ step: null, bookingCode: null, phoneVerified: false }),
  }),
  pendingCancelFlowAction: Annotation<CancelFlowAction | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  switchTopicAfterAbort: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false,
  }),
});

// ─── Run Options ─────────────────────────────────────────────────────────────

export interface GraphRunOptions {
  /** Conversation history to process */
  messages: LLMMessage[];
  /** Site UUID for scoping tool calls */
  siteId: string;
  /** Conversation UUID for context injection */
  conversationId: string;
  /** Last unambiguous conversation locale persisted in the database */
  currentLocale?: string | null;
  /** Multi-turn flow whose locale is currently locked */
  activeFlow?: string | null;
  /** Locale locked for the active multi-turn flow */
  activeFlowLocale?: string | null;
  /** Custom system prompt override for the site */
  systemPromptOverride?: string | null;
  /** Max tokens per response */
  maxTokensPerResponse?: number;
  /** Visitor details to provide context to the LLM */
  visitorContext?: {
    name?: string;
    email?: string;
  };
  /** Site details to provide context to the LLM */
  siteContext?: {
    name?: string;
    domains?: string[];
    bookingEnabled?: boolean;
    humanHandoffEnabled?: boolean;
    bookingServices?: { id: string; name: string }[];
    bookingResources?: { id: string; name: string }[];
    bookingHours?: {
      timezone?: string | null;
      availableDays?: number[];
      startTime?: string;
      endTime?: string;
      slotDuration?: number;
    };
    industryTemplateId?: string;
    industryTemplateConfig?: Record<string, unknown>;
  };
  /** Existing rolling summary (loaded from conversation.summary) */
  existingSummary?: string;
  /** Count of already-summarised messages */
  existingSummarizedMessageCount?: number;
  /**
   * Express Response object for the SSE HTTP stream (visitor).
   * Agent writes tokens directly with res.write(token). Optional —
   * when called from the gateway (WebSocket-only path) this is omitted.
   */
  res?: ExpressResponse;
  /**
   * Socket.io Server instance for WebSocket fan-out (admin dashboard).
   * Agent emits 'aiChunk' events to the conversation room.
   */
  server: SocketServer;
  /** Callback after graph finishes — caller saves the AI message to DB */
  onFinish: (
    text: string,
    knowledgeSources?: {
      documentId: string;
      filename: string;
      sourceUrl?: string;
    }[],
    locale?: string,
    components?: ChatMessageComponent[],
  ) => Promise<void>;
  /** Callback when the graph triggers a human handoff */
  onRequestHandoff: () => Promise<void>;
  /** Whether sentiment detection is enabled */
  sentimentDetection?: boolean;
  /** Callback when negative sentiment is detected by the intent classifier */
  onNegativeSentiment?: (text: string) => Promise<void>;
  /** Flag to prevent duplicate alerts */
  hasNegativeSentiment?: boolean;
  /** Initial cancel state parsed from last AI message or explicit state */
  initialCancelState?: CancelState;
  /**
   * The Site entity — used by AiService.buildModelForSite() to resolve BYOK key.
   * When provided and site.useCustomOpenAiKey is true, the per-site encrypted key is used.
   */
  site?: {
    id?: string;
    useCustomOpenAiKey?: boolean;
    encryptedOpenAiKey?: string | null;
    llmModel?: string | null;
    customBaseUrl?: string | null;
  };
}

export interface GraphRunResult {
  newSummary?: string;
  newSummarizedMessageCount?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * GraphService — LangGraph orchestration layer.
 *
 * Responsibilities:
 *  - Expose runStream() as the low-level entry point for running the graph.
 *  - Expose handleVisitorMessage() as the high-level entry point used by both
 *    ChatController (SSE) and ChatGateway (WebSocket).
 *  - Guard: check site.isAiActive && conversation.isAiActive before running.
 *  - Fan out LLM tokens to both HTTP SSE (res.write) and WebSocket (server.emit).
 *  - Persist updated summary and summarizedMessageCount to the database.
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly testSessionMessages = new Map<string, LLMMessage[]>();

  constructor(
    private readonly aiService: AiService,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
    @Inject(TOOL_PROVIDER)
    private readonly toolProviderFactory: IToolProviderFactory,
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(ChatMessageEntity)
    private readonly chatMessageRepo: Repository<ChatMessageEntity>,
    @InjectRepository(Site)
    private readonly siteRepo: Repository<Site>,
    @Inject(forwardRef(() => BookingService))
    private readonly bookingService: BookingService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    private readonly notificationService: NotificationService,
  ) {}

  // ─── AI Guard ──────────────────────────────────────────────────────────────

  /**
   * Checks both layers of the AI active flag before running the graph.
   * Returns false (and logs) when AI should not respond.
   */
  async canRunAi(conversationId: string, siteId: string): Promise<boolean> {
    if (conversationId.startsWith('admin-test-')) {
      return true;
    }

    const [conversation, site] = await Promise.all([
      this.conversationRepo.findOne({ where: { id: conversationId } }),
      this.siteRepo.findOne({ where: { id: siteId } }),
    ]);

    if (!site) {
      this.logger.warn(`canRunAi: site ${siteId} not found`);
      return false;
    }

    if (!conversation) {
      this.logger.warn(`canRunAi: conversation ${conversationId} not found`);
      return false;
    }

    if (!site.isAiActive) {
      this.logger.log(
        `AI skipped — site ${siteId} has isAiActive=false (site toggle off)`,
      );
      return false;
    }

    if (!conversation.isAiActive) {
      this.logger.log(
        `AI skipped — conversation ${conversationId} has isAiActive=false (agent took over)`,
      );
      return false;
    }

    return true;
  }

  // ─── High-level entry point (called by Controller & Gateway) ───────────────

  /**
   * High-level handler for a visitor message.
   * Loads the conversation context, checks the AI guard, builds the message
   * history, defines callbacks, and delegates to runStream().
   */
  async handleVisitorMessage(
    conversationId: string,
    siteId: string,
    res?: ExpressResponse,
    onNegativeSentiment?: (text: string) => Promise<void>,
    newTestMessageContent?: string,
  ): Promise<void> {
    const aiEnabled = await this.canRunAi(conversationId, siteId);
    if (!aiEnabled) {
      if (res) res.end();
      return;
    }

    if (conversationId.startsWith('admin-test-')) {
      const site = await this.siteRepo
        .createQueryBuilder('site')
        .addSelect(['site.encryptedOpenAiKey', 'site.systemPromptOverride'])
        .leftJoinAndSelect('site.industryTemplateInfo', 'industryTemplateInfo')
        .leftJoinAndSelect('site.bookingConfig', 'bookingConfig')
        .leftJoinAndSelect('site.bookingServices', 'bookingServices')
        .leftJoinAndSelect('site.bookingResources', 'bookingResources')
        .where('site.id = :siteId', { siteId })
        .getOne();

      if (!this.testSessionMessages.has(conversationId)) {
        this.testSessionMessages.set(conversationId, []);
      }
      const history = this.testSessionMessages.get(conversationId)!;
      if (newTestMessageContent) {
        history.push({ role: 'user', content: newTestMessageContent });
      }

      const onFinish = (
        text: string,
        _knowledgeSources?: {
          documentId: string;
          filename: string;
          sourceUrl?: string;
        }[],
        locale?: string,
        components?: ChatMessageComponent[],
      ): Promise<void> => {
        history.push({ role: 'assistant', content: text });
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('newMessage', {
            id: `ai-msg-${Date.now()}`,
            conversationId,
            content: text,
            senderType: 'AI',
            createdAt: new Date().toISOString(),
            locale,
            components,
          });
        return Promise.resolve();
      };

      const onRequestHandoff = (): Promise<void> => {
        // No handoff in sandbox test
        return Promise.resolve();
      };

      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('ai-stream-start', { conversationId });

      try {
        await this.runStream({
          messages: [...history],
          siteId,
          conversationId,
          systemPromptOverride: site?.systemPromptOverride ?? null,
          maxTokensPerResponse: site?.maxTokensPerResponse ?? 1000,
          visitorContext: {
            name: 'Admin Tester',
          },
          siteContext: {
            name: site?.name ?? undefined,
            domains: site?.allowedDomains ?? [],
            bookingEnabled: site?.bookingEnabled === true,
            bookingServices:
              site?.bookingServices?.map((service) => ({
                id: service.id,
                name: service.name,
              })) ?? [],
            bookingResources:
              site?.bookingResources?.map((resource) => ({
                id: resource.id,
                name: resource.name,
              })) ?? [],
            bookingHours: site?.bookingConfig
              ? {
                  timezone: site.bookingConfig.bookingTimezone,
                  availableDays: site.bookingConfig.bookingAvailableDays,
                  startTime: site.bookingConfig.bookingStartTime,
                  endTime: site.bookingConfig.bookingEndTime,
                  slotDuration: site.bookingConfig.bookingSlotDuration,
                }
              : undefined,
            industryTemplateId: site?.industryTemplateId,
            industryTemplateConfig: site?.industryTemplateInfo?.config,
          },
          res,
          server: this.chatGateway.server,
          onFinish,
          onRequestHandoff,
          sentimentDetection: false,
          site: site ?? undefined,
        });
      } finally {
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('ai-stream-end', { conversationId });
      }
      return;
    }

    const [conversation, site, dbMessages] = await Promise.all([
      this.chatService.getConversationById(conversationId),
      this.siteRepo
        .createQueryBuilder('site')
        .addSelect(['site.encryptedOpenAiKey', 'site.systemPromptOverride'])
        .leftJoinAndSelect('site.industryTemplateInfo', 'industryTemplateInfo')
        .leftJoinAndSelect('site.bookingConfig', 'bookingConfig')
        .leftJoinAndSelect('site.bookingServices', 'bookingServices')
        .leftJoinAndSelect('site.bookingResources', 'bookingResources')
        .where('site.id = :siteId', { siteId })
        .getOne(),
      this.chatService.getMessagesForConversation(
        conversationId,
        undefined,
        '30',
      ),
    ]);

    const messages: LLMMessage[] = dbMessages.map((m) => ({
      role:
        m.senderType === SenderType.VISITOR
          ? ('user' as const)
          : ('assistant' as const),
      content: m.content,
    }));

    const lastAiDbMsg = dbMessages
      .slice()
      .reverse()
      .find((m) => m.senderType === SenderType.AI);

    const lastAiContent = lastAiDbMsg?.content ?? '';
    const cancelMarker = lastAiContent.match(/\[cancel:(\w+)\|([^\]]*)\]/);

    const initialCancelState: CancelState = {
      step: (cancelMarker?.[1] as CancelStep) ?? null,
      bookingCode: cancelMarker?.[2] || null,
      phoneVerified: cancelMarker?.[1] === 'await_confirm',
    };

    const onFinish = async (
      text: string,
      _knowledgeSources?: {
        documentId: string;
        filename: string;
        sourceUrl?: string;
      }[],
      locale?: string,
      components?: ChatMessageComponent[],
    ) => {
      console.log(`text to save ${text}`);
      const savedMessage = await this.chatService.saveMessage(
        conversationId,
        text,
        SenderType.AI,
        undefined,
        locale,
        components,
      );

      const cleanDisplayContent = text
        .replace(/\s*\[cancel:[^\]]+\]/g, '')
        .replace(/<booking-code>.*?<\/booking-code>/g, '')
        .replace(/<booking-cancelled>.*?<\/booking-cancelled>/g, '')
        .trim();

      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('newMessage', {
          id: savedMessage.id,
          conversationId,
          content: cleanDisplayContent || text,
          senderType: 'AI',
          createdAt: savedMessage.createdAt,
          locale: savedMessage.locale ?? locale,
          components: savedMessage.components ?? components,
        });
    };

    const onRequestHandoff = async () => {
      await this.chatService.escalateToAgent(conversationId);
    };

    this.chatGateway.server
      .to(`conversation-${conversationId}`)
      .emit('ai-stream-start', { conversationId });

    try {
      const result = await this.runStream({
        messages,
        siteId,
        conversationId,
        currentLocale: conversation.currentLocale,
        activeFlow: conversation.activeFlow,
        activeFlowLocale: conversation.activeFlowLocale,
        systemPromptOverride: site?.systemPromptOverride ?? null,
        maxTokensPerResponse: site?.maxTokensPerResponse ?? 1000,
        visitorContext: {
          name: conversation.visitorName ?? undefined,
          email: conversation.visitorEmail ?? undefined,
        },
        siteContext: {
          name: site?.name ?? undefined,
          domains: site?.allowedDomains ?? [],
          bookingEnabled: site?.bookingEnabled === true,
          humanHandoffEnabled: site?.humanHandoff === true,
          bookingServices:
            site?.bookingServices?.map((service) => ({
              id: service.id,
              name: service.name,
            })) ?? [],
          bookingResources:
            site?.bookingResources?.map((resource) => ({
              id: resource.id,
              name: resource.name,
            })) ?? [],
          bookingHours: site?.bookingConfig
            ? {
                timezone: site.bookingConfig.bookingTimezone,
                availableDays: site.bookingConfig.bookingAvailableDays,
                startTime: site.bookingConfig.bookingStartTime,
                endTime: site.bookingConfig.bookingEndTime,
                slotDuration: site.bookingConfig.bookingSlotDuration,
              }
            : undefined,
          industryTemplateId: site?.industryTemplateId,
          industryTemplateConfig: site?.industryTemplateInfo?.config,
        },
        existingSummary: conversation.summary ?? undefined,
        existingSummarizedMessageCount: conversation.summarizedMessageCount,
        res,
        server: this.chatGateway.server,
        onFinish,
        onRequestHandoff,
        sentimentDetection: site?.sentimentDetection ?? false,
        onNegativeSentiment,
        hasNegativeSentiment: conversation.hasNegativeSentiment,
        initialCancelState,
        site: site ?? undefined,
      });
      console.log(`result::: ${JSON.stringify(result)}`);
    } finally {
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('ai-stream-end', { conversationId });
    }
  }

  /**
   * High-level entry point for Admin In-Dashboard Testing (Stateless SSE).
   * Runs the full RAG / LangGraph pipeline using in-memory conversation history.
   * Completely bypasses database persistence (no rows in conversations or chat_messages).
   */
  async handleAdminTestStream(
    dto: AdminTestStreamDto,
    site: Site,
    res: ExpressResponse,
  ): Promise<void> {
    const messages: LLMMessage[] = dto.messages.map((m) => ({
      role:
        m.role === 'user'
          ? ('user' as const)
          : m.role === 'assistant'
            ? ('assistant' as const)
            : ('system' as const),
      content: m.content,
    }));

    const dummyConversationId = `admin-test-${Date.now()}`;

    try {
      await this.runStream({
        messages,
        siteId: site.id,
        conversationId: dummyConversationId,
        systemPromptOverride:
          dto.systemPromptOverride ?? site.systemPromptOverride ?? null,
        maxTokensPerResponse: site.maxTokensPerResponse ?? 1000,
        visitorContext: {
          name: 'Admin Tester',
        },
        siteContext: {
          name: site.name ?? undefined,
          domains: site.allowedDomains ?? [],
          bookingEnabled: site.bookingEnabled === true,
          bookingServices:
            site.bookingServices?.map((service) => ({
              id: service.id,
              name: service.name,
            })) ?? [],
          bookingResources:
            site.bookingResources?.map((resource) => ({
              id: resource.id,
              name: resource.name,
            })) ?? [],
          bookingHours: site.bookingConfig
            ? {
                timezone: site.bookingConfig.bookingTimezone,
                availableDays: site.bookingConfig.bookingAvailableDays,
                startTime: site.bookingConfig.bookingStartTime,
                endTime: site.bookingConfig.bookingEndTime,
                slotDuration: site.bookingConfig.bookingSlotDuration,
              }
            : undefined,
          industryTemplateConfig: site.industryTemplateInfo?.config,
        },
        res,
        server: this.chatGateway.server,
        onFinish: async () => {
          // In-memory test session: do not write to database
        },
        onRequestHandoff: async () => {
          // In-memory test session: do not escalate to agent
        },
        sentimentDetection: false,
      });
    } catch (err) {
      this.logger.error(`[AdminTestStream] Error: ${String(err)}`);
      if (res && !res.writableEnded) {
        res.write(
          `\n\n[Error: ${err instanceof Error ? err.message : 'AI service unavailable'}]`,
        );
        res.end();
      }
    }
  }

  // ─── Low-level graph runner ─────────────────────────────────────────────────

  /**
   * Runs the full LangGraph workflow for a single visitor message.
   * Streams tokens to both HTTP SSE and WebSocket simultaneously.
   */
  async runStream(options: GraphRunOptions): Promise<GraphRunResult> {
    const {
      messages,
      siteId,
      conversationId,
      existingSummary = '',
      existingSummarizedMessageCount = 0,
      res,
      server,
      onFinish,
      onRequestHandoff,
    } = options;

    let toolProvider: IToolProvider | undefined;
    let createdBookingCode: string | undefined;
    let cancelledBookingCode: string | undefined;
    let streamedTokensCount = 0;
    let bookingSlotsEmitted = false;
    const latestUserText =
      messages
        .slice()
        .reverse()
        .find((message) => message.role === 'user')?.content ?? '';
    const requestedTimeSlot = extractRequestedTimeSlot(latestUserText);
    const selectedFromWidget = isBookingSlotSelection(latestUserText);
    const hasStructuredBookingProgress = hasActiveStructuredBookingProgress(
      messages,
      options.activeFlow,
    );
    let requestedSlotAvailability: boolean | undefined;
    let currentLocale = normalizeLocale(options.currentLocale, DEFAULT_LOCALE);
    let activeFlow = options.activeFlow ?? null;
    let activeFlowLocale = options.activeFlowLocale
      ? normalizeLocale(options.activeFlowLocale, currentLocale)
      : null;

    const applyLocaleState = async (
      intent: IntentType,
      detectedLocale?: string | null,
    ) => {
      const detected = normalizeLocale(detectedLocale);
      const resolvedIntent = intent;

      if (intent === 'abandon_booking' || intent === 'abort_cancel_flow') {
        activeFlow = null;
        activeFlowLocale = null;
      }

      if (detected !== UNDETERMINED_LOCALE && !activeFlow) {
        currentLocale = detected;
      }

      if (
        !activeFlow &&
        (resolvedIntent === 'book_appointment' ||
          resolvedIntent === 'book_appointment_init' ||
          resolvedIntent === 'structured_booking_step' ||
          resolvedIntent === 'booking_slot_selected')
      ) {
        activeFlow = 'BOOKING';
        activeFlowLocale = resolveEffectiveLocale({
          detectedLocale: detected,
          currentLocale,
        });
      } else if (!activeFlow && resolvedIntent === 'cancel_booking') {
        activeFlow = 'CANCELLATION';
        activeFlowLocale = resolveEffectiveLocale({
          detectedLocale: detected,
          currentLocale,
        });
      }

      const locale = resolveEffectiveLocale({
        activeFlowLocale,
        detectedLocale: detected,
        currentLocale,
      });

      await this.conversationRepo.update(options.conversationId, {
        currentLocale,
        activeFlow,
        activeFlowLocale,
      });

      return {
        intent: resolvedIntent,
        locale,
        activeFlow,
        activeFlowLocale,
      };
    };

    const clearActiveFlow = async () => {
      activeFlow = null;
      activeFlowLocale = null;
      await this.conversationRepo.update(options.conversationId, {
        currentLocale,
        activeFlow: null,
        activeFlowLocale: null,
      });
    };

    try {
      // ── 1. Build LangChain messages from raw LLMMessage array ──────────────
      const langchainMessages: BaseMessage[] = messages.map((m) => {
        if (m.role === 'user') {
          const parsed = parseMultimodalContent(m.content);
          return typeof parsed === 'string'
            ? new HumanMessage(parsed)
            : new HumanMessage({ content: parsed });
        }
        if (m.role === 'assistant') return new AIMessage(m.content);
        return new SystemMessage(m.content);
      });

      // ── 2. Load tools from provider and wrap as LangChain tools ────────────
      toolProvider = await this.toolProviderFactory.create({
        siteId,
        conversationId,
      });
      const toolDefs = await toolProvider.listTools();
      const currentProvider = toolProvider;
      const langchainTools = toolDefs.map(
        (def) =>
          new DynamicStructuredTool({
            name: def.name,
            description: def.description,
            schema: buildToolSchema(def.schema),
            func: async (args) => {
              if (!currentProvider)
                throw new Error('Tool provider not initialized');

              let toolArgs: Record<string, unknown> = args;

              if (
                def.name === 'holdSlot' &&
                requestedTimeSlot &&
                !selectedFromWidget
              ) {
                if (args.timeSlot !== requestedTimeSlot) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message: `Hold the visitor's exact requested time ${requestedTimeSlot}, not another slot.`,
                  });
                }
                if (requestedSlotAvailability !== true) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      requestedSlotAvailability === false
                        ? 'The requested time slot is unavailable. Do not continue this booking.'
                        : 'Call getAvailableSlots and verify the requested time before holding it.',
                  });
                }
              }

              if (def.name === 'draftBooking' || def.name === 'createBooking') {
                const lastUserMessage = messages
                  .slice()
                  .reverse()
                  .find((message) => message.role === 'user')?.content;

                if (
                  def.name === 'createBooking' &&
                  !/^\/confirm-booking\b/i.test(lastUserMessage?.trim() ?? '')
                ) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. Display the booking draft for visitor confirmation first.',
                  });
                }

                const userMessages = messages
                  .filter((message) => message.role === 'user')
                  .map((message) => message.content.trim().toLowerCase());
                const slotSelection = messages
                  .slice()
                  .reverse()
                  .filter((message) => message.role === 'user')
                  .map((message) => parseBookingSlotSelection(message.content))
                  .find(Boolean);
                const services = options.siteContext?.bookingServices ?? [];
                const resources = options.siteContext?.bookingResources ?? [];

                const matchedServices = services.filter((item) => {
                  if (
                    Array.isArray(args.serviceIds) &&
                    (args.serviceIds as string[]).includes(item.id)
                  )
                    return true;
                  if (args.serviceId === item.id) return true;
                  if (
                    Array.isArray(args.serviceNames) &&
                    (args.serviceNames as string[]).some(
                      (n) => n.toLowerCase() === item.name.toLowerCase(),
                    )
                  )
                    return true;
                  if (
                    typeof args.serviceName === 'string' &&
                    args.serviceName.toLowerCase() === item.name.toLowerCase()
                  )
                    return true;
                  return userMessages.some((msg) =>
                    msg.includes(item.name.toLowerCase()),
                  );
                });

                const service =
                  matchedServices[0] ??
                  services.find((item) => item.id === args.serviceId);
                const serviceIds =
                  matchedServices.length > 0
                    ? matchedServices.map((s) => s.id)
                    : Array.isArray(args.serviceIds)
                      ? (args.serviceIds as string[])
                      : service?.id
                        ? [service.id]
                        : [];
                const serviceNames = serviceIds
                  .map((id) => services.find((s) => s.id === id)?.name)
                  .filter(Boolean) as string[];

                const resource =
                  resources.find((item) => item.id === args.resourceId) ??
                  resources.find(
                    (item) => item.id === slotSelection?.resourceId,
                  ) ??
                  resources.find((item) =>
                    userMessages.some(
                      (message) =>
                        message === item.name.toLowerCase() ||
                        message.endsWith(` with ${item.name.toLowerCase()}`),
                    ),
                  );

                const slotCount =
                  typeof args.slotCount === 'number'
                    ? args.slotCount
                    : (slotSelection?.slotCount ??
                      Math.max(1, serviceIds.length));

                const finalSlots = args.slots ?? slotSelection?.slots;
                const config = options.siteContext?.bookingHours;
                const duration = config?.slotDuration || 30;

                let calculatedEndTimeSlot =
                  (args.endTimeSlot as string) ?? slotSelection?.endTimeSlot;

                if (!calculatedEndTimeSlot && slotCount > 1) {
                  const startSlot =
                    (args.timeSlot as string) ?? slotSelection?.timeSlot;
                  if (startSlot) {
                    const [h, m] = startSlot.split(':').map(Number);
                    const totalEndMins = h * 60 + m + duration * slotCount;
                    const endH = Math.floor(totalEndMins / 60) % 24;
                    const endM = totalEndMins % 60;
                    calculatedEndTimeSlot = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
                  }
                }

                toolArgs = {
                  ...args,
                  serviceId: serviceIds[0] ?? service?.id ?? args.serviceId,
                  serviceIds: serviceIds.length > 0 ? serviceIds : undefined,
                  slotCount,
                  resourceId: resource?.id ?? args.resourceId,
                  date: args.date ?? slotSelection?.date,
                  timeSlot: args.timeSlot ?? slotSelection?.timeSlot,
                  endTimeSlot: calculatedEndTimeSlot,
                  slots: finalSlots,
                };

                if (!resource) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. A specific staff/resource must be selected before booking. Ask the user to choose one available staff member, or choose one available staff member from the selected slot and state it clearly.',
                  });
                }

                if (
                  services.length > 0 &&
                  !service &&
                  serviceIds.length === 0
                ) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. A valid service from the current site must be selected before booking.',
                  });
                }

                if (def.name === 'draftBooking') {
                  this.logger.log(
                    `[Tool Node] Executing tool: draftBooking -> emitting bookingSummary card`,
                  );

                  this.chatGateway.emitBookingSummary(conversationId, {
                    ...toolArgs,
                    locale: activeFlowLocale ?? currentLocale,
                    serviceId: serviceIds[0] ?? service?.id,
                    serviceIds: serviceIds.length ? serviceIds : undefined,
                    serviceName:
                      serviceNames[0] ?? service?.name ?? args.serviceName,
                    serviceNames: serviceNames.length
                      ? serviceNames
                      : undefined,
                    slotCount,
                    slots: finalSlots,
                    endTimeSlot: calculatedEndTimeSlot,
                    resourceName: resource?.name ?? args.resourceName,
                  });
                  return JSON.stringify({
                    success: true,
                    draftReady: true,
                    message:
                      'The booking summary card has been displayed on the widget for customer review and confirmation. Ask the visitor in one short, polite sentence to review and confirm on the card below.',
                  });
                }

                const confirmMatch = lastUserMessage?.match(
                  /^\/confirm-booking\s+((?:(?!\s*::).)*)/is,
                )?.[1];
                if (confirmMatch) {
                  try {
                    const parsedConfirm = JSON.parse(confirmMatch) as Record<
                      string,
                      unknown
                    >;
                    if (typeof parsedConfirm.slots === 'string') {
                      try {
                        parsedConfirm.slots = JSON.parse(parsedConfirm.slots);
                      } catch {
                        // ignore
                      }
                    }
                    if (typeof parsedConfirm.serviceIds === 'string') {
                      try {
                        parsedConfirm.serviceIds = JSON.parse(
                          parsedConfirm.serviceIds,
                        );
                      } catch {
                        // ignore
                      }
                    }
                    toolArgs = {
                      ...toolArgs,
                      ...parsedConfirm,
                    };
                  } catch (e: unknown) {
                    this.logger.warn(
                      `Failed to parse confirm-booking JSON: ${e instanceof Error ? e.message : String(e)}`,
                    );
                  }
                }

                if (conversationId.startsWith('admin-test-')) {
                  this.logger.log(
                    `[Tool Node] Mock booking execution in test mode: ${conversationId}`,
                  );
                  const mockBookingCode = `TEST-BK${Math.floor(1000 + Math.random() * 9000)}`;
                  const mockResult = {
                    bookingCode: mockBookingCode,
                    status: 'confirmed',
                    customerName: toolArgs.customerName,
                    phone: toolArgs.phone,
                    serviceName: service?.name ?? serviceNames[0] ?? 'Service',
                    resourceName: resource?.name ?? 'Staff',
                    date: toolArgs.date,
                    timeSlot: toolArgs.timeSlot,
                  };
                  createdBookingCode = mockBookingCode;
                  this.chatGateway.emitBookingSuccess(
                    conversationId,
                    mockResult,
                  );
                  return JSON.stringify(mockResult);
                }
              }

              this.logger.log(`[Tool Node] Executing tool: ${def.name}`);
              try {
                const result = await currentProvider.execute({
                  name: def.name,
                  arguments: toolArgs,
                });
                if (def.name === 'getAvailableSlots' && requestedTimeSlot) {
                  requestedSlotAvailability = isTimeSlotAvailable(
                    result.output,
                    requestedTimeSlot,
                  );
                }
                return typeof result.output === 'string'
                  ? result.output
                  : JSON.stringify(result.output ?? {});
              } catch (err) {
                this.logger.error(
                  `[Tool Node] Tool execution error for ${def.name}:`,
                  err,
                );
                return JSON.stringify({
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            },
          }),
      );

      // Separate the human-handoff tool (handled by request_handoff node)
      // and restrict admin-only/future tools from visitors
      const restrictedForVisitor = [
        'listDocuments',
        'cancelBooking',
        'getUserDetails',
      ];
      const aiTools = langchainTools.filter(
        (t) =>
          !t.name.includes('requestHumanAgent') &&
          !restrictedForVisitor.includes(t.name),
      );
      const toolNode = new ToolNode(aiTools);

      const toolsForIntent = (intent: IntentType, latestUserText: string) => {
        const allowedToolNamesByIntent: Partial<
          Record<NonNullable<IntentType>, string[]>
        > = {
          small_talk: [],
          system_question: [],
          out_of_scope: [],
          abandon_booking: [],
          question: [],
          book_appointment: bookAppointmentToolNames(latestUserText),
          booking_slot_selected: [
            'getSiteConfig',
            'holdSlot',
            'releaseHold',
            'draftBooking',
            'createBooking',
          ],
          cancel_booking: ['getConversationContext', 'cancelBooking'],
          check_booking: ['getConversationContext'],
        };

        const allowedToolNames = intent
          ? allowedToolNamesByIntent[intent]
          : undefined;

        return allowedToolNames
          ? aiTools.filter((tool) => allowedToolNames.includes(tool.name))
          : aiTools;
      };

      const messageText = (message: BaseMessage) => {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) {
          return message.content
            .map((c) => {
              if (typeof c === 'string') return c;
              if (
                c &&
                typeof c === 'object' &&
                'text' in c &&
                typeof (c as { text: string }).text === 'string'
              ) {
                return (c as { text: string }).text;
              }
              return '';
            })
            .filter(Boolean)
            .join(' ')
            .trim();
        }
        return JSON.stringify(message.content);
      };

      const getLatestUserText = (state: typeof AgentState.State): string => {
        const msg = [...state.messages]
          .reverse()
          .find((m) => m.constructor?.name?.includes('HumanMessage'));
        return msg ? messageText(msg) : '';
      };

      const activeConversationBookingCode = async (
        state: typeof AgentState.State,
      ) => {
        if (conversationId.startsWith('admin-test-')) {
          return latestActiveBookingCode(
            [state.summary, ...state.messages.map(messageText)].join('\n'),
          );
        }
        const metadataMessages = await this.chatMessageRepo.find({
          where: [
            { conversationId, content: Like('%<booking-code>%') },
            { conversationId, content: Like('%Booking code:%') },
            { conversationId, content: Like('%Mã đặt lịch:%') },
            { conversationId, content: Like('%<booking-cancelled>%') },
          ],
          select: { content: true },
          order: { createdAt: 'ASC' },
        });
        return latestActiveBookingCode(
          [
            ...metadataMessages.map((message) => message.content),
            state.summary,
            ...state.messages.map(messageText),
          ].join('\n'),
        );
      };

      // ── 4. Define graph nodes ────────────────────────────────────────────────

      /**
       * classify_intent — uses a cold model call to label the latest user message.
       */
      const classifyIntent = async (state: typeof AgentState.State) => {
        const lastMessage = state.messages[state.messages.length - 1];
        const contentStr =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
        const bookingEnabled = state.siteContext.bookingEnabled === true;

        const isCancelAbortPhrase = (text: string): boolean =>
          /^\/keep-booking\b/i.test(text) ||
          /^\/(?:abandon-cancel|cancel-abort)\b/i.test(text) ||
          /(?:thôi|không|đừng)\s*(?:hủy|huỷ)(?:\s*nữa)?/i.test(text) ||
          /(?:đổi\s*ý|giữ\s*lịch|bỏ\s*qua|không\s*muốn\s*hủy)/i.test(text) ||
          /\b(?:nevermind|keep\s*my\s*booking|don'?t\s*cancel|abort\s*cancel|stop\s*cancel(?:lation)?)\b/i.test(
            text,
          ) ||
          /(?:キャンセルしない|やめる|維持する|そのまま)/i.test(text);

        if (isCancelAbortPhrase(contentStr)) {
          this.logger.log('[Fast-Path Intent] cancel flow abort');
          return {
            ...(await applyLocaleState('abort_cancel_flow', state.locale)),
            pendingCancelFlowAction: 'ABORT_CANCELLATION' as CancelFlowAction,
            switchTopicAfterAbort: false,
          };
        }

        if (
          state.cancelState?.step !== null &&
          state.cancelState?.step !== undefined
        ) {
          const cancelStep = state.cancelState.step;
          const extractedCode = extractBookingCode(contentStr);
          const extractedPhone = extractPhoneFromText(contentStr);

          if (
            /^\/(?:(?:confirm-)?cancel-booking|keep-booking)\b/i.test(
              contentStr,
            )
          ) {
            return applyLocaleState('cancel_booking', state.locale);
          }

          if (cancelStep === 'ask_code' && extractedCode) {
            return applyLocaleState('cancel_booking', state.locale);
          }
          if (cancelStep === 'verify_phone' && extractedPhone) {
            return applyLocaleState('cancel_booking', state.locale);
          }
          if (
            cancelStep === 'await_confirm' &&
            /^\/confirm-cancel-booking\b/i.test(contentStr)
          ) {
            return applyLocaleState('cancel_booking', state.locale);
          }

          try {
            const actionSchema = z.object({
              action: z
                .enum(['PROVIDE_INFO', 'ABORT_CANCELLATION', 'SWITCH_TOPIC'])
                .catch('SWITCH_TOPIC'),
            });
            const model = this.aiService
              .buildModelForSite(options.site ?? {}, 0, false)
              .withStructuredOutput(actionSchema);
            const actionResult = await model.invoke([
              new SystemMessage(
                getCancelFlowClassifierPrompt(cancelStep, state.locale),
              ),
              new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
            ]);

            this.logger.log(
              `Cancel flow classifier action: ${actionResult.action} (step: ${cancelStep})`,
            );

            if (actionResult.action === 'PROVIDE_INFO') {
              return applyLocaleState('cancel_booking', state.locale);
            }

            if (actionResult.action === 'ABORT_CANCELLATION') {
              return {
                ...(await applyLocaleState('abort_cancel_flow', state.locale)),
                pendingCancelFlowAction:
                  'ABORT_CANCELLATION' as CancelFlowAction,
                switchTopicAfterAbort: false,
              };
            }

            if (actionResult.action === 'SWITCH_TOPIC') {
              return {
                ...(await applyLocaleState('abort_cancel_flow', state.locale)),
                pendingCancelFlowAction: 'SWITCH_TOPIC' as CancelFlowAction,
                switchTopicAfterAbort: true,
              };
            }
          } catch (err) {
            this.logger.warn(
              'Cancel flow classifier failed, falling back',
              err,
            );
            if (!extractedCode && !extractedPhone) {
              return {
                ...(await applyLocaleState('abort_cancel_flow', state.locale)),
                pendingCancelFlowAction: 'SWITCH_TOPIC' as CancelFlowAction,
                switchTopicAfterAbort: true,
              };
            }
            return applyLocaleState('cancel_booking', state.locale);
          }
        }

        // ── 1. Fast-Path Check (Deterministic routing without LLM call) ──
        if (/^\/(?:update-draft-booking|confirm-booking)\b/i.test(contentStr)) {
          this.logger.log(
            '[Fast-Path Intent] structured_booking_step (update/confirm)',
          );
          return applyLocaleState('structured_booking_step', activeFlowLocale);
        }

        if (/^\/abandon-booking\b/i.test(contentStr)) {
          this.logger.log('[Fast-Path Intent] abandoned booking');
          return applyLocaleState(
            'abandon_booking',
            contentStr.match(/"locale"\s*:\s*"([^"]+)"/i)?.[1],
          );
        }

        if (activeFlow === 'BOOKING' && isBookingAbandonment(contentStr)) {
          this.logger.log('[Fast-Path Intent] natural booking abandonment');
          return applyLocaleState('abandon_booking', activeFlowLocale);
        }

        const bookingOption = parseBookingOptionSelection(contentStr);
        if (bookingOption) {
          const intent = bookingOptionNeedsModel(bookingOption)
            ? 'book_appointment'
            : 'structured_booking_step';
          this.logger.log(`[Fast-Path Intent] ${intent} option`);
          return applyLocaleState(intent, bookingOption.locale);
        }

        if (isBookingSlotSelection(contentStr)) {
          this.logger.log('[Fast-Path Intent] structured_booking_step slot');
          return applyLocaleState(
            'structured_booking_step',
            parseBookingSlotSelection(contentStr)?.language,
          );
        }

        if (/^\/(?:confirm-)?cancel-booking\b/i.test(contentStr)) {
          this.logger.log('[Fast-Path Intent] cancel_booking');
          return applyLocaleState('cancel_booking', activeFlowLocale);
        }

        if (bookingEnabled) {
          const triggerLocale = detectBookingTriggerLocale(
            contentStr,
            currentLocale,
          );
          if (triggerLocale) {
            this.logger.log(
              `[Fast-Path Intent] natural book_appointment_init trigger (${triggerLocale})`,
            );
            return applyLocaleState('book_appointment_init', triggerLocale);
          }
        }

        if (!activeFlow) {
          const smallTalkLocale = detectSmallTalkLocale(
            contentStr,
            currentLocale,
          );
          if (smallTalkLocale) {
            this.logger.log(
              `[Fast-Path Intent] small_talk trigger (${smallTalkLocale})`,
            );
            return applyLocaleState('small_talk', smallTalkLocale);
          }
        }

        // ── 2. LLM Intent Classifier (Fallback for open questions & ambiguous messages) ──
        const intents = bookingEnabled
          ? ([
              'question',
              'system_question',
              'out_of_scope',
              'request_human',
              'small_talk',
              'book_appointment',
              'check_booking',
              'cancel_booking',
              'abandon_booking',
            ] as const)
          : ([
              'question',
              'system_question',
              'out_of_scope',
              'request_human',
              'small_talk',
            ] as const);

        const intentSchema = z.object({
          intent: z.enum(intents).catch('small_talk'),
          sentiment: z
            .enum(['positive', 'neutral', 'negative'])
            .catch('neutral'),
          locale: z.string().catch(UNDETERMINED_LOCALE),
        });

        try {
          const model = this.aiService
            .buildModelForSite(options.site ?? {}, 0, false)
            .withStructuredOutput(intentSchema);

          const response = await model.invoke([
            new SystemMessage(
              getIntentClassifierPrompt(
                bookingEnabled,
                activeFlow === 'BOOKING',
                state.siteContext.humanHandoffEnabled === true,
              ),
            ),
            new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
          ]);

          this.logger.log(
            `Intent classified: ${response.intent}, Sentiment: ${response.sentiment}, Locale: ${response.locale}`,
          );

          const intent = shouldContinueBookingFlow(
            activeFlow,
            response.intent,
            contentStr,
            state.siteContext,
          )
            ? 'book_appointment'
            : response.intent;
          if (intent !== response.intent) {
            this.logger.log(
              `Intent overridden for booking continuation: ${response.intent} -> ${intent}`,
            );
          }

          if (
            options.sentimentDetection &&
            response.sentiment === 'negative' &&
            options.onNegativeSentiment
          ) {
            if (!options.hasNegativeSentiment) {
              this.logger.log(
                `Negative sentiment detected for conversation ${options.conversationId}. Alerting agents.`,
              );

              options
                .onNegativeSentiment(contentStr)
                .catch((err: unknown) =>
                  this.logger.error(
                    `Error in onNegativeSentiment callback: ${err instanceof Error ? err.message : String(err)}`,
                    err,
                  ),
                );

              await this.conversationRepo.update(options.conversationId, {
                hasNegativeSentiment: true,
              });
            }
          }

          return applyLocaleState(intent, response.locale);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const isAuthOrQuota =
            errMsg.includes('401') ||
            errMsg.includes('Incorrect API key') ||
            errMsg.includes('invalid_api_key') ||
            errMsg.includes('429') ||
            errMsg.includes('insufficient_quota') ||
            errMsg.includes('MODEL_AUTHENTICATION') ||
            errMsg.includes('Failed to decrypt site custom API key') ||
            errMsg.includes(
              'Site has custom API key enabled (BYOK) but no encrypted key',
            );

          if (
            isAuthOrQuota &&
            options.site?.useCustomOpenAiKey &&
            options.site?.id
          ) {
            void this.siteRepo
              .update(options.site.id, { customKeyStatus: 'invalid' })
              .catch((dbErr) =>
                this.logger.error(
                  `Failed to update customKeyStatus to 'invalid' for site ${options.site?.id}`,
                  dbErr,
                ),
              );
          }

          this.logger.warn(
            `Intent classification fallback for site ${options.site?.id ?? 'unknown'}: ${errMsg.slice(0, 150)}`,
          );
          return applyLocaleState(
            shouldContinueBookingFlow(activeFlow, 'small_talk')
              ? 'book_appointment'
              : 'small_talk',
            UNDETERMINED_LOCALE,
          );
        }
      };

      /**
       * request_handoff — updates the conversation status, notifies agents,
       * and writes a canned handoff message.
       */
      const requestHandoff = async (state: typeof AgentState.State) => {
        if (!options.siteContext?.humanHandoffEnabled) {
          const isVi = localeLanguage(state.locale) === 'vi';
          const noHandoffMsg = isVi
            ? 'Tính năng kết nối trực tiếp với nhân viên hiện không khả dụng. Tôi là trợ lý ảo AI, tôi có thể tiếp tục hỗ trợ bạn giải đáp các thông tin.'
            : 'Live agent support is currently unavailable. I am an AI assistant and will continue to help you with your inquiries.';

          if (res) {
            res.write(noHandoffMsg);
          }

          server
            .to(`conversation-${conversationId}`)
            .emit('aiChunk', { token: noHandoffMsg, conversationId });

          return { messages: [new AIMessage(noHandoffMsg)] };
        }

        await onRequestHandoff();

        const handoffMsg =
          'An agent has been notified and will be with you shortly.';

        if (res) {
          res.write(handoffMsg);
        }

        server
          .to(`conversation-${conversationId}`)
          .emit('aiChunk', { token: handoffMsg, conversationId });

        return { messages: [new AIMessage(handoffMsg)] };
      };

      const buildCancellationPayload = (booking: {
        code: string;
        status: string;
        customerName: string;
        phone: string;
        serviceId?: string | null;
        service?: { name: string } | null;
        resourceId?: string | null;
        resource?: { name: string } | null;
        startAt: Date;
        timezone: string;
      }) => ({
        bookingCode: booking.code,
        status: booking.status,
        customerName: booking.customerName,
        phone: booking.phone,
        serviceId: booking.serviceId ?? undefined,
        serviceName: booking.service?.name,
        resourceId: booking.resourceId ?? undefined,
        resourceName: booking.resource?.name,
        date: formatInTimeZone(booking.startAt, booking.timezone, 'yyyy-MM-dd'),
        timeSlot: formatInTimeZone(booking.startAt, booking.timezone, 'HH:mm'),
      });

      const handleAskCode = async (
        state: typeof AgentState.State,
        userText: string,
        prompts: CancelPrompts,
      ) => {
        const abortChip = getAbortChip(state.locale);
        const bookingCode =
          extractBookingCode(userText) ??
          (await activeConversationBookingCode(state));

        if (!bookingCode) {
          return {
            cancelState: {
              step: 'ask_code' as CancelStep,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [
              new AIMessage(
                `${prompts.askCode} [cancel:ask_code|]${abortChip}`,
              ),
            ],
          };
        }

        const booking = await this.bookingService
          .getBookingByCode(state.siteId, bookingCode)
          .catch(() => null);

        if (!booking) {
          await clearActiveFlow();
          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.notFound)],
          };
        }

        if (booking.status.toLowerCase() === 'cancelled') {
          await clearActiveFlow();
          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.alreadyCancelled)],
          };
        }

        return {
          cancelState: {
            step: 'verify_phone' as CancelStep,
            bookingCode,
            phoneVerified: false,
          },
          messages: [
            new AIMessage(
              `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]${abortChip}`,
            ),
          ],
        };
      };

      const handleVerifyPhone = async (
        state: typeof AgentState.State,
        userText: string,
        prompts: CancelPrompts,
      ) => {
        const { bookingCode } = state.cancelState;
        const abortChip = getAbortChip(state.locale);
        const isVietnamese = localeLanguage(state.locale) === 'vi';
        const isVi = isVietnamese;

        if (!bookingCode) {
          return {
            cancelState: {
              step: 'ask_code' as CancelStep,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [
              new AIMessage(
                `${prompts.askCode} [cancel:ask_code|]${abortChip}`,
              ),
            ],
          };
        }

        if (conversationId.startsWith('admin-test-')) {
          const testCancellationPayload = {
            bookingCode,
            status: 'confirmed',
            customerName: 'Admin Tester',
            phone: '0901234567',
            serviceId: undefined,
            serviceName: 'Dịch vụ thử nghiệm',
            resourceId: undefined,
            resourceName: 'Nhân viên thử nghiệm',
            date: new Date().toISOString().split('T')[0],
            timeSlot: '10:00',
          };

          if (!/^\/confirm-cancel-booking\b/i.test(userText)) {
            this.chatGateway.emitBookingCancellation(
              conversationId,
              testCancellationPayload,
            );
            return {
              messages: [
                new AIMessage(
                  isVi
                    ? 'Vui lòng kiểm tra và xác nhận hủy lịch.'
                    : 'Please review and confirm the booking cancellation.',
                ),
              ],
            };
          }

          cancelledBookingCode = bookingCode;
          this.chatGateway.emitBookingCancelled(conversationId, {
            ...testCancellationPayload,
            status: 'cancelled',
          });
          return {
            messages: [
              new AIMessage(
                isVi
                  ? 'Lịch đặt thử nghiệm của bạn đã được hủy.'
                  : 'Your test booking has been cancelled.',
              ),
            ],
          };
        }

        const booking = await this.bookingService
          .getBookingByCode(state.siteId, bookingCode)
          .catch(() => null);

        if (!booking) {
          await clearActiveFlow();
          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.notFound)],
          };
        }

        const providedPhone = extractPhoneFromText(userText);
        if (!providedPhone) {
          return {
            cancelState: state.cancelState,
            messages: [
              new AIMessage(
                `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]${abortChip}`,
              ),
            ],
          };
        }

        const isPhoneMatch =
          normalizePhone(providedPhone) === normalizePhone(booking.phone);

        if (!isPhoneMatch) {
          return {
            cancelState: state.cancelState,
            messages: [
              new AIMessage(
                `${prompts.phoneWrong} [cancel:verify_phone|${bookingCode}]${abortChip}`,
              ),
            ],
          };
        }

        const payload = {
          ...buildCancellationPayload(booking),
          locale: state.locale,
        };
        this.chatGateway.emitBookingCancellation(conversationId, payload);

        return {
          cancelState: {
            step: 'await_confirm' as CancelStep,
            bookingCode,
            phoneVerified: true,
          },
          messages: [
            new AIMessage(
              `${prompts.confirmCancel} [cancel:await_confirm|${bookingCode}]`,
            ),
          ],
        };
      };

      const handleConfirmExecute = async (
        state: typeof AgentState.State,
        userText: string,
        prompts: CancelPrompts,
      ) => {
        const { bookingCode } = state.cancelState;

        if (/^\/keep-booking\b/i.test(userText)) {
          await clearActiveFlow();
          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.keepConfirmed)],
          };
        }

        if (/^\/confirm-cancel-booking\b/i.test(userText)) {
          if (!bookingCode) {
            await clearActiveFlow();
            return {
              cancelState: {
                step: null,
                bookingCode: null,
                phoneVerified: false,
              },
              messages: [new AIMessage(prompts.cancelFail)],
            };
          }

          this.logger.log(
            `[cancelBookingNode] Executing cancelBooking for code: ${bookingCode}`,
          );
          const result = await currentProvider.execute({
            name: 'cancelBooking',
            arguments: { bookingCode },
          });

          const resultOutput = result.output;
          if (resultOutput?.status !== 'cancelled') {
            await clearActiveFlow();
            return {
              cancelState: {
                step: null,
                bookingCode: null,
                phoneVerified: false,
              },
              messages: [new AIMessage(prompts.cancelFail)],
            };
          }

          cancelledBookingCode = bookingCode;
          const booking = await this.bookingService
            .getBookingByCode(state.siteId, bookingCode)
            .catch(() => null);
          if (booking) {
            this.chatGateway.emitBookingCancelled(conversationId, {
              ...buildCancellationPayload(booking),
              ...resultOutput,
              locale: state.locale,
            });
          }

          await clearActiveFlow();

          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.cancelSuccess)],
          };
        }

        if (bookingCode) {
          const booking = await this.bookingService
            .getBookingByCode(state.siteId, bookingCode)
            .catch(() => null);
          if (booking) {
            this.chatGateway.emitBookingCancellation(conversationId, {
              ...buildCancellationPayload(booking),
              locale: state.locale,
            });
          }
        }

        return {
          cancelState: state.cancelState,
          messages: [
            new AIMessage(
              `${prompts.confirmCancel} [cancel:await_confirm|${bookingCode ?? ''}]`,
            ),
          ],
        };
      };

      const cancelBookingNode = async (state: typeof AgentState.State) => {
        const userText = getLatestUserText(state);
        const detectedLang = state.locale;
        const prompts = getCancelPrompts(detectedLang);

        switch (state.cancelState?.step) {
          case 'verify_phone':
            return handleVerifyPhone(state, userText, prompts);
          case 'await_confirm':
            return handleConfirmExecute(state, userText, prompts);
          default:
            return handleAskCode(state, userText, prompts);
        }
      };

      const abortCancelFlowNode = (state: typeof AgentState.State) => {
        const prompts = getCancelPrompts(state.locale);
        const action = state.pendingCancelFlowAction;
        const resetState: CancelState = {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        };

        if (action === 'SWITCH_TOPIC' || state.switchTopicAfterAbort) {
          this.logger.log(
            '[abortCancelFlowNode] Topic switch requested — resetting cancelState and re-classifying intent',
          );
          return {
            cancelState: resetState,
            pendingCancelFlowAction: null as CancelFlowAction | null,
            switchTopicAfterAbort: true,
          };
        }

        const keepMsg = prompts.keepConfirmed;
        if (res) {
          res.write(keepMsg);
        }
        server
          ?.to(`conversation-${conversationId}`)
          ?.emit('aiChunk', { token: keepMsg, conversationId });

        return {
          cancelState: resetState,
          pendingCancelFlowAction: null as CancelFlowAction | null,
          switchTopicAfterAbort: false,
          messages: [new AIMessage(keepMsg)],
        };
      };

      const systemQuestionNode = (state: typeof AgentState.State) => ({
        messages: [
          new AIMessage(
            getPublicCapabilitiesPrompt(
              state.locale,
              state.siteContext.bookingEnabled === true,
            ),
          ),
        ],
      });

      const outOfScopeNode = (state: typeof AgentState.State) => ({
        messages: [
          new AIMessage(
            getOutOfScopePrompt(
              state.locale,
              state.siteContext.bookingEnabled === true,
            ),
          ),
        ],
      });

      const abandonBookingNode = (state: typeof AgentState.State) => ({
        messages: [new AIMessage(getAbandonBookingPrompt(state.locale))],
      });

      const initBookingNode = (state: typeof AgentState.State) => {
        const services = options.siteContext?.bookingServices ?? [];
        const resources = options.siteContext?.bookingResources ?? [];
        const templateId = options.siteContext?.industryTemplateId;
        if (services.length > 0) {
          const prompt = getBookingOptionPrompt(
            state.locale,
            'service',
            templateId,
          );
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>service</booking-step>`,
              ),
            ],
          };
        }
        if (resources.length > 0) {
          const prompt = getBookingOptionPrompt(
            state.locale,
            'resource',
            templateId,
          );
          return {
            messages: [
              new AIMessage(
                `${prompt}\n\n<booking-step>resource</booking-step>`,
              ),
            ],
          };
        }
        const prompt = getBookingOptionPrompt(state.locale, 'date', templateId);
        return {
          messages: [
            new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
          ],
        };
      };

      const structuredBookingStepNode = async (
        state: typeof AgentState.State,
      ) => {
        const userText = getLatestUserText(state).trim();
        const locale = state.locale;
        const bookingOption = parseBookingOptionSelection(userText);
        const slotSelection = parseBookingSlotSelection(userText);
        const services = options.siteContext?.bookingServices ?? [];
        const resources = options.siteContext?.bookingResources ?? [];
        const lang = localeLanguage(locale);

        // 1. Handle /update-draft-booking command
        const updateDraftJson = extractBookingCommandJson(
          userText,
          'update-draft-booking',
        );
        if (updateDraftJson) {
          try {
            const draftPayload = JSON.parse(updateDraftJson) as Record<
              string,
              unknown
            >;
            const service = services.find(
              (s) => s.id === draftPayload.serviceId,
            );
            const resource = resources.find(
              (r) => r.id === draftPayload.resourceId,
            );

            const holdDate =
              typeof draftPayload.date === 'string' ? draftPayload.date : '';
            const holdTimeSlot =
              typeof draftPayload.timeSlot === 'string'
                ? draftPayload.timeSlot
                : '';
            const holdResourceId =
              typeof draftPayload.resourceId === 'string'
                ? draftPayload.resourceId
                : '';

            // Execute holdSlot immediately for the updated slot/resource to ensure it is locked
            let updatedSessionId =
              typeof draftPayload.sessionId === 'string'
                ? draftPayload.sessionId
                : undefined;
            if (currentProvider && holdResourceId && holdDate && holdTimeSlot) {
              try {
                this.logger.log(
                  `[Structured Step] Updating hold on draft edit: date=${holdDate}, timeSlot=${holdTimeSlot}, resourceId=${holdResourceId}`,
                );
                const holdResult = await currentProvider.execute({
                  name: 'holdSlot',
                  arguments: {
                    resourceId: holdResourceId,
                    serviceId: draftPayload.serviceId,
                    date: holdDate,
                    timeSlot: holdTimeSlot,
                    slotCount:
                      typeof draftPayload.slotCount === 'number'
                        ? draftPayload.slotCount
                        : Array.isArray(draftPayload.slots)
                          ? draftPayload.slots.length
                          : 1,
                    slots: draftPayload.slots,
                    sessionId: draftPayload.sessionId,
                  },
                });
                if (
                  holdResult?.output &&
                  typeof holdResult.output === 'object' &&
                  'sessionId' in holdResult.output
                ) {
                  updatedSessionId = (
                    holdResult.output as { sessionId: string }
                  ).sessionId;
                }
              } catch (holdErr) {
                this.logger.error(
                  '[Structured Step] Failed to hold slot on update-draft-booking',
                  holdErr,
                );
              }
            }

            // Resolve ordered serviceNames if serviceIds is present
            const rawServiceIds = Array.isArray(draftPayload.serviceIds)
              ? (draftPayload.serviceIds as string[])
              : draftPayload.serviceId
                ? [draftPayload.serviceId as string]
                : [];
            const serviceNames: string[] = [];
            for (const sId of rawServiceIds) {
              const matched = services.find((s) => s.id === sId);
              if (matched) serviceNames.push(matched.name);
            }

            this.chatGateway.emitBookingSummary(conversationId, {
              ...draftPayload,
              sessionId: updatedSessionId,
              locale: activeFlowLocale ?? currentLocale,
              serviceId: rawServiceIds[0] ?? service?.id,
              serviceIds: rawServiceIds.length > 0 ? rawServiceIds : undefined,
              serviceName:
                serviceNames[0] ??
                service?.name ??
                (draftPayload.serviceName as string),
              serviceNames: serviceNames.length > 0 ? serviceNames : undefined,
              resourceName:
                resource?.name ?? (draftPayload.resourceName as string),
            });
            const prompt =
              lang === 'vi'
                ? 'Vui lòng xem lại thông tin đặt lịch ở thẻ bên dưới và bấm xác nhận để hoàn tất.'
                : lang === 'ja'
                  ? '下のカードで予約内容を確認し、確定してください。'
                  : 'Please review the booking details on the card below and confirm to complete.';
            return {
              messages: [new AIMessage(prompt)],
            };
          } catch (err) {
            this.logger.error(
              '[Structured Step] Failed update-draft-booking',
              err,
            );
          }
        }

        // 2. Handle /confirm-booking command
        const confirmBookingJson = extractBookingCommandJson(
          userText,
          'confirm-booking',
        );
        if (confirmBookingJson && currentProvider) {
          try {
            const confirmPayload = JSON.parse(confirmBookingJson) as Record<
              string,
              unknown
            >;
            const cleanedConfirmPayload = { ...confirmPayload };
            if (
              typeof cleanedConfirmPayload.serviceId === 'string' &&
              !cleanedConfirmPayload.serviceId.trim()
            ) {
              delete cleanedConfirmPayload.serviceId;
            }
            if (Array.isArray(cleanedConfirmPayload.serviceIds)) {
              const filtered = (
                cleanedConfirmPayload.serviceIds as string[]
              ).filter((id) => typeof id === 'string' && id.trim().length > 0);
              if (filtered.length > 0) {
                cleanedConfirmPayload.serviceIds = filtered;
              } else {
                delete cleanedConfirmPayload.serviceIds;
              }
            }
            if (Array.isArray(cleanedConfirmPayload.slots)) {
              cleanedConfirmPayload.slots = (
                cleanedConfirmPayload.slots as Array<Record<string, unknown>>
              ).map((s) => {
                const cleanedSlot = { ...s };
                if (
                  typeof cleanedSlot.serviceId === 'string' &&
                  !cleanedSlot.serviceId.trim()
                ) {
                  delete cleanedSlot.serviceId;
                }
                return cleanedSlot;
              });
            }
            this.logger.log(
              `[Structured Step] Executing createBooking directly: ${JSON.stringify(cleanedConfirmPayload)}`,
            );
            const result = await currentProvider.execute({
              name: 'createBooking',
              arguments: cleanedConfirmPayload,
            });
            const p = result.output;
            if (p && !p.error && typeof p.bookingCode === 'string') {
              createdBookingCode = p.bookingCode;
              this.chatGateway.emitBookingSuccess(conversationId, {
                ...p,
                locale: state.locale,
              });
              await clearActiveFlow();
              const prompt =
                lang === 'vi'
                  ? 'Đặt lịch thành công! Cảm ơn bạn.'
                  : lang === 'ja'
                    ? 'ご予約が完了しました！ありがとうございます。'
                    : 'Your booking is confirmed! Thank you.';
              return {
                messages: [new AIMessage(prompt)],
              };
            } else if (p?.error) {
              const errorMsg =
                typeof p.error === 'string'
                  ? p.error
                  : 'Booking failed. Please try again.';
              return {
                messages: [new AIMessage(errorMsg)],
              };
            }
          } catch (err) {
            this.logger.error('[Structured Step] Failed confirm-booking', err);
          }
        }

        const templateId = options.siteContext?.industryTemplateId;
        // 3. Handle /select-booking-option actions
        if (bookingOption) {
          if (bookingOption.action === 'select_service') {
            if (resources.length === 0) {
              const prompt = getBookingOptionPrompt(locale, 'date', templateId);
              return {
                messages: [
                  new AIMessage(
                    `${prompt}\n\n<booking-step>date</booking-step>`,
                  ),
                ],
              };
            }
            const prompt = getBookingOptionPrompt(
              locale,
              'resource',
              templateId,
            );
            return {
              messages: [
                new AIMessage(
                  `${prompt}\n\n<booking-step>resource</booking-step>`,
                ),
              ],
            };
          }

          if (
            bookingOption.action === 'select_resource' ||
            bookingOption.action === 'no_preference'
          ) {
            const prompt = getBookingOptionPrompt(locale, 'date', templateId);
            return {
              messages: [
                new AIMessage(`${prompt}\n\n<booking-step>date</booking-step>`),
              ],
            };
          }

          if (bookingOption.action === 'choose_date') {
            const prompt =
              lang === 'vi'
                ? 'Vui lòng nhập ngày bạn muốn đặt lịch (ví dụ: ngày mai, hoặc DD/MM/YYYY).'
                : lang === 'ja'
                  ? 'ご希望の予約日を入力してください（例：明日、またはYYYY-MM-DD）。'
                  : 'Please provide the date you would like to book (e.g. tomorrow, or YYYY-MM-DD).';
            return {
              messages: [new AIMessage(prompt)],
            };
          }

          if (bookingOption.action === 'select_date' && currentProvider) {
            const selectedDate = bookingOption.value;
            const userMessages = state.messages
              .filter((m) => m.constructor?.name?.includes('HumanMessage'))
              .map(messageText);

            const serviceOpt = userMessages
              .map((t) => parseBookingOptionSelection(t))
              .filter((o) => o?.action === 'select_service')
              .pop();
            const resourceOpt = userMessages
              .map((t) => parseBookingOptionSelection(t))
              .filter(
                (o) =>
                  o?.action === 'select_resource' ||
                  o?.action === 'no_preference',
              )
              .pop();

            const serviceId =
              serviceOpt?.value ??
              services.find((s) => s.id === serviceOpt?.value)?.id ??
              services.find((s) =>
                userMessages.some((msg) =>
                  msg.toLowerCase().includes(s.name.toLowerCase()),
                ),
              )?.id ??
              services[0]?.id;

            const resourceId =
              resourceOpt?.action === 'no_preference'
                ? undefined
                : (resourceOpt?.value ??
                  resources.find((r) => r.id === resourceOpt?.value)?.id ??
                  resources.find((r) =>
                    userMessages.some(
                      (msg) =>
                        msg.toLowerCase() === r.name.toLowerCase() ||
                        msg
                          .toLowerCase()
                          .endsWith(` with ${r.name.toLowerCase()}`),
                    ),
                  )?.id);

            try {
              this.logger.log(
                `[Structured Step] Calling getAvailableSlots directly: date=${selectedDate}, serviceId=${serviceId}, resourceId=${resourceId}`,
              );
              const result = await currentProvider.execute({
                name: 'getAvailableSlots',
                arguments: {
                  date: selectedDate,
                  serviceId,
                  resourceId,
                },
              });
              this.chatGateway.emitBookingSlots(conversationId, result.output);
              bookingSlotsEmitted = true;

              const prompt = getSlotCardPrompt(locale);
              return {
                messages: [new AIMessage(prompt)],
              };
            } catch (err) {
              this.logger.error(
                '[Structured Step] Failed to fetch slots directly',
                err,
              );
              return {
                messages: [new AIMessage(getSlotCardPrompt(locale))],
              };
            }
          }

          if (
            bookingOption.action === 'submit_text' &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || '')
          ) {
            const prompt =
              lang === 'vi'
                ? 'Bạn vui lòng cho biết số điện thoại để tiếp tục.\n\n<booking-input>phone</booking-input>'
                : lang === 'ja'
                  ? '電話番号を入力してください。\n\n<booking-input>phone</booking-input>'
                  : 'Please provide your phone number to continue.\n\n<booking-input>phone</booking-input>';
            return {
              messages: [new AIMessage(prompt)],
            };
          }

          if (
            bookingOption.action === 'skip_email' ||
            (bookingOption.action === 'submit_text' &&
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || ''))
          ) {
            const userMessages = state.messages
              .filter((m) => m.constructor?.name?.includes('HumanMessage'))
              .map(messageText);

            const latestSlotSel = state.messages
              .slice()
              .reverse()
              .filter((m) => m.constructor?.name?.includes('HumanMessage'))
              .map((m) => parseBookingSlotSelection(messageText(m)))
              .find(Boolean);

            const serviceOpt = userMessages
              .map((t) => parseBookingOptionSelection(t))
              .filter((o) => o?.action === 'select_service')
              .pop();

            const resourceOpt = userMessages
              .map((t) => parseBookingOptionSelection(t))
              .filter(
                (o) =>
                  o?.action === 'select_resource' ||
                  o?.action === 'no_preference',
              )
              .pop();

            const nameOpt = userMessages
              .map((t) => parseBookingOptionSelection(t))
              .filter(
                (o) =>
                  o?.action === 'submit_text' &&
                  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.value || ''),
              )
              .shift();

            const phoneMsg = userMessages
              .filter(
                (t) =>
                  /^[+0-9\s().-]{7,25}$/.test(t.trim()) &&
                  !t.startsWith('/select-') &&
                  !t.startsWith('/confirm-') &&
                  !t.startsWith('/update-'),
              )
              .pop();

            const submittedEmail =
              bookingOption.action === 'submit_text' &&
              /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingOption.value || '')
                ? bookingOption.value
                : undefined;

            const rawName =
              nameOpt?.value ??
              nameOpt?.label ??
              options.visitorContext?.name ??
              '';

            const serviceId =
              serviceOpt?.value ??
              services.find((s) => s.id === serviceOpt?.value)?.id ??
              (services.length > 0 ? services[0]?.id : undefined);

            const resourceId =
              latestSlotSel?.resourceId ??
              (resourceOpt?.action === 'no_preference'
                ? undefined
                : (resourceOpt?.value ?? resources[0]?.id));

            const service = services.find((s) => s.id === serviceId);
            const resource = resources.find((r) => r.id === resourceId);
            const slotCount =
              latestSlotSel?.slotCount ??
              (Array.isArray(latestSlotSel?.slots)
                ? latestSlotSel.slots.length
                : 1);

            const serviceIds = serviceId
              ? Array(slotCount).fill(serviceId)
              : undefined;
            const serviceNames = service
              ? Array(slotCount).fill(service.name)
              : undefined;

            this.chatGateway.emitBookingSummary(conversationId, {
              locale: activeFlowLocale ?? currentLocale,
              customerName: rawName || 'Khách hàng',
              phone: phoneMsg?.trim() ?? '',
              customerEmail: submittedEmail,
              serviceId,
              serviceIds,
              serviceName: service?.name,
              serviceNames,
              resourceId,
              resourceName: resource?.name,
              date: latestSlotSel?.date,
              timeSlot: latestSlotSel?.timeSlot,
              endTimeSlot: latestSlotSel?.endTimeSlot,
              slotCount,
              slots: latestSlotSel?.slots,
            });

            const prompt =
              lang === 'vi'
                ? 'Vui lòng xem và xác nhận thông tin đặt lịch trong thẻ bên dưới.'
                : lang === 'ja'
                  ? '下のカードで予約内容を確認し、確定してください。'
                  : 'Please review and confirm your booking details in the card below.';
            return {
              messages: [new AIMessage(prompt)],
            };
          }
        }

        // 4. Handle /select-booking-slot
        if (slotSelection && currentProvider) {
          try {
            const slotCount =
              slotSelection.slotCount ??
              (Array.isArray(slotSelection.slots)
                ? slotSelection.slots.length
                : 1);
            this.logger.log(
              `[Structured Step] Calling holdSlot directly: date=${slotSelection.date}, timeSlot=${slotSelection.timeSlot}, resourceId=${slotSelection.resourceId}, slotCount=${slotCount}`,
            );
            await currentProvider.execute({
              name: 'holdSlot',
              arguments: {
                date: slotSelection.date,
                timeSlot: slotSelection.timeSlot,
                resourceId: slotSelection.resourceId,
                slotCount,
                slots: slotSelection.slots,
              },
            });
          } catch (err) {
            this.logger.error('[Structured Step] Failed to hold slot', err);
          }

          const hasName = !!options.visitorContext?.name;
          const prompt = getBookingOptionPrompt(locale, 'name');
          const marker = hasName ? '\n\n<booking-step>name</booking-step>' : '';
          return {
            messages: [new AIMessage(`${prompt}${marker}`)],
          };
        }

        return {};
      };

      const knowledgeFallbackNode = (state: typeof AgentState.State) => ({
        messages: [
          new AIMessage(
            getKnowledgeFallbackPrompt(
              state.locale,
              state.knowledgeSearchStatus === 'error',
            ),
          ),
        ],
      });

      const searchKnowledgeNode = async (state: typeof AgentState.State) => {
        const query = getLatestUserText(state).trim();
        const toolCallId = `knowledge-${state.conversationId}-${state.messages.length}`;
        let output: Record<string, unknown>;

        try {
          const result = await currentProvider.execute({
            name: 'searchKnowledge',
            arguments: { query },
          });
          output = result.output;
        } catch (error) {
          this.logger.error(
            '[Knowledge Search] Forced retrieval failed',
            error,
          );
          output = { error: 'Knowledge retrieval unavailable' };
        }

        return {
          messages: [
            new AIMessage({
              content: '',
              tool_calls: [
                {
                  name: 'searchKnowledge',
                  args: { query },
                  id: toolCallId,
                  type: 'tool_call',
                },
              ],
            }),
            new ToolMessage({
              content: JSON.stringify(output),
              tool_call_id: toolCallId,
              name: 'searchKnowledge',
            }),
          ],
        };
      };

      /**
       * model_node — invokes the bound LLM with tools, streaming tokens to both
       * the HTTP response (visitor) and the WebSocket room (admin dashboard).
       */
      const modelNode = async (state: typeof AgentState.State) => {
        const isSmallTalk = state.intent === 'small_talk';
        const isBookingFlow = isBookingFlowIntent(state.intent);
        const promptSiteContext = isSmallTalk
          ? {
              name: state.siteContext.name,
              domains: state.siteContext.domains,
            }
          : isBookingFlow
            ? state.siteContext
            : { ...state.siteContext, bookingEnabled: false };
        const convertedMessages: LLMMessage[] = state.messages.map((m) => ({
          role: m.constructor?.name?.includes('HumanMessage')
            ? ('user' as const)
            : ('assistant' as const),
          content: messageText(m),
        }));
        let systemPrompt = this.aiService.buildSystemPrompt({
          messages: convertedMessages,
          summary: state.summary,
          siteId: state.siteId,
          conversationId: state.conversationId,
          visitorContext: state.visitorContext,
          siteContext: promptSiteContext,
          systemPromptOverride: options.systemPromptOverride,
          locale: state.locale,
        });
        if (isSmallTalk) {
          systemPrompt +=
            '\n\nCurrent intent: small talk. Reply briefly to the user message. Do not mention or list booking services, staff, resources, availability, or booking options. Do not output chips or call tools.';
        }
        if (
          state.knowledgeSearchStatus === 'success' ||
          state.knowledgeSearchStatus === 'empty'
        ) {
          systemPrompt += `\n\n${getKnowledgeGroundingRule(state.knowledgeSearchStatus)}`;
        }

        const messagesWithSystem = [
          new SystemMessage(systemPrompt),
          ...state.messages,
        ];
        const visibleTools = toolsForIntent(
          state.intent,
          getLatestUserText(state),
        ).filter(
          (tool) =>
            state.knowledgeSearchStatus === 'idle' ||
            tool.name !== 'searchKnowledge',
        );
        this.logger.log(
          `[Tool Binding] intent=${state.intent ?? 'unknown'} tools=${visibleTools.map((tool) => tool.name).join(', ')}`,
        );
        const shouldStream = state.intent !== 'book_appointment';
        const temperature = state.intent === 'book_appointment' ? 0.0 : 0.2;
        let response;
        try {
          const boundModel = this.aiService
            .buildModelForSite(
              options.site ?? {},
              temperature,
              shouldStream,
              options.maxTokensPerResponse,
            )
            .bindTools(visibleTools);

          response = await boundModel.invoke(messagesWithSystem, {
            callbacks: [
              {
                handleLLMNewToken(token: string) {
                  if (!shouldStream) return;
                  if (token) {
                    streamedTokensCount++;
                    // 1. HTTP SSE — visitor receives tokens
                    if (res) {
                      res.write(token);
                    }
                    // 2. WebSocket — admin dashboard receives tokens
                    server
                      .to(`conversation-${conversationId}`)
                      .emit('aiChunk', { token, conversationId });
                  }
                },
              },
            ],
          });
        } catch (modelError) {
          const errMsg =
            modelError instanceof Error
              ? modelError.message
              : String(modelError);

          if (options.site?.useCustomOpenAiKey) {
            this.logger.error(
              `Custom OpenAI key on site ${options.site?.id ?? 'unknown'} failed (${errMsg.slice(0, 150)}). Strict BYOK mode active: Master key fallback is disabled.`,
            );

            // Update database so Dashboard & UI reflect that custom key is invalid
            if (options.site?.id) {
              void this.siteRepo
                .update(options.site.id, { customKeyStatus: 'invalid' })
                .catch((dbErr) =>
                  this.logger.error(
                    `Failed to update customKeyStatus to 'invalid' for site ${options.site?.id}`,
                    dbErr,
                  ),
                );
            }

            const errorReply =
              'The AI service for this site is currently unavailable due to an invalid or quota-exceeded custom API key (BYOK). Please contact the site administrator.';

            if (res && !res.writableEnded) {
              res.write(errorReply);
            }
            server
              ?.to(`conversation-${conversationId}`)
              ?.emit('aiChunk', { token: errorReply, conversationId });

            response = new AIMessage(errorReply);
          } else {
            throw modelError;
          }
        }

        return { messages: [response] };
      };

      /**
       * parse_tools — extracts knowledge source references from searchKnowledge
       * tool responses so they can be attached to the saved AI message.
       * Also intercepts booking tool calls to emit UI events.
       */
      const parseTools = async (state: typeof AgentState.State) => {
        const calledTools = state.messages
          .filter((m) => m.constructor?.name?.includes('ToolMessage') || m.name)
          .map((m) => m.name)
          .filter(Boolean);
        this.logger.log(
          `[Parse Tools] Tools called: ${Array.from(new Set(calledTools)).join(', ')}`,
        );

        const recentToolMessages: BaseMessage[] = [];
        for (let index = state.messages.length - 1; index >= 0; index -= 1) {
          const message = state.messages[index];
          if (!(message instanceof ToolMessage)) break;
          recentToolMessages.unshift(message as BaseMessage);
        }

        const sourcesMap = new Map<
          string,
          { filename: string; sourceUrl?: string }
        >();
        let knowledgeAttempted = false;
        let knowledgeFailed = false;
        let knowledgeResultCount = 0;

        for (const toolMessage of recentToolMessages) {
          const isKnowledgeSearch =
            toolMessage.name?.includes('searchKnowledge');
          try {
            const rawContent =
              typeof toolMessage.content === 'string'
                ? toolMessage.content
                : JSON.stringify(toolMessage.content);
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(rawContent);
            } catch {
              parsed = null;
            }

            if (!parsed) {
              continue;
            }

            // Handle booking tools interception
            if (toolMessage.name?.includes('getAvailableSlots')) {
              if (!requestedTimeSlot) {
                this.chatGateway.emitBookingSlots(conversationId, parsed);
                bookingSlotsEmitted = true;
              }
            } else if (toolMessage.name?.includes('createBooking')) {
              const p =
                parsed && typeof parsed === 'object'
                  ? (parsed as Record<string, unknown>)
                  : null;
              const hasError = !!p?.error;
              const bookingCode = p?.bookingCode;
              if (
                !hasError &&
                typeof bookingCode === 'string' &&
                bookingCode.trim().length > 0
              ) {
                createdBookingCode = bookingCode;
                this.chatGateway.emitBookingSuccess(conversationId, {
                  ...(parsed as Record<string, unknown>),
                  locale: state.locale,
                });
                await clearActiveFlow();
              }

              if (p?.isSummaryCardEmitted || p?.error === 'ACTION_REQUIRED') {
                const isVietnamese = localeLanguage(state.locale) === 'vi';
                const summaryMsg = isVietnamese
                  ? 'Dạ, thông tin đặt lịch của bạn đã được cập nhật đầy đủ. Vui lòng kiểm tra và xác nhận trên phiếu đặt lịch bên dưới nhé!'
                  : 'Your booking summary is ready. Please review and confirm your details below!';

                if (res) {
                  res.write(summaryMsg);
                }
                server
                  ?.to(`conversation-${conversationId}`)
                  ?.emit('aiChunk', { token: summaryMsg, conversationId });

                return {
                  messages: [new AIMessage(summaryMsg)],
                };
              }
            }

            // Handle searchKnowledge
            if (isKnowledgeSearch) {
              knowledgeAttempted = true;
              const knowledgeOutput = parseKnowledgeSearchOutput(parsed);
              if (knowledgeOutput.status === 'error') {
                knowledgeFailed = true;
                this.logger.warn('[Knowledge Search] Tool failed');
                continue;
              }

              const results = knowledgeOutput.chunks;
              knowledgeResultCount += results.length;
              results.forEach((c: unknown) => {
                if (c && typeof c === 'object') {
                  const chunk = c as Record<string, unknown>;
                  if (
                    typeof chunk.documentId === 'string' &&
                    typeof chunk.filename === 'string'
                  ) {
                    sourcesMap.set(chunk.documentId, {
                      filename: chunk.filename,
                      sourceUrl:
                        typeof chunk.sourceUrl === 'string'
                          ? chunk.sourceUrl
                          : undefined,
                    });
                  }
                }
              });
            }
          } catch (error) {
            this.logger.error('Failed to parse tool output', error);
            if (isKnowledgeSearch) {
              knowledgeAttempted = true;
              knowledgeFailed = true;
            }
          }
        }

        if (knowledgeAttempted) {
          const knowledgeSearchStatus: KnowledgeSearchStatus =
            knowledgeResultCount > 0
              ? 'success'
              : knowledgeFailed
                ? 'error'
                : 'empty';
          const knowledgeSources = Array.from(sourcesMap.entries()).map(
            ([documentId, source]) => ({ documentId, ...source }),
          );
          this.logger.log(
            `[Knowledge Search] status=${knowledgeSearchStatus} chunks=${knowledgeResultCount} sources=${knowledgeSources.length}`,
          );
          return { knowledgeSearchStatus, knowledgeSources };
        }

        return {};
      };

      /**
       * summarize_memory — triggers when active message count exceeds threshold.
       * Calls the LLM to produce a rolling summary and trims the active message
       * list to the most recent 2. Persists the new summary to the database.
       */
      const SUMMARIZE_THRESHOLD = 25;
      const summarizeMemory = (state: typeof AgentState.State) => {
        if (state.messages.length <= SUMMARIZE_THRESHOLD) return {};

        this.logger.log(
          `Message threshold (${SUMMARIZE_THRESHOLD}) exceeded. Summarising memory in background...`,
        );

        const messagesToSummarize = state.messages.slice(
          0,
          state.messages.length - 2,
        );

        const summaryPrompt = state.summary
          ? `Update the following conversation summary with the new messages. Keep it concise.\n\nCurrent Summary: ${state.summary}\n\nNew Messages:\n${JSON.stringify(messagesToSummarize)}`
          : `Summarise the following conversation concisely:\n${JSON.stringify(messagesToSummarize)}`;

        // Background execution — do not await to keep visitor response instantaneous
        this.aiService
          .invoke({
            messages: [{ role: 'user', content: summaryPrompt }],
          })
          .then(async (response) => {
            const newSummary = response.content;
            const newCount =
              state.summarizedMessageCount + messagesToSummarize.length;
            if (!conversationId.startsWith('admin-test-')) {
              await this.conversationRepo.update(conversationId, {
                summary: newSummary,
                summarizedMessageCount: newCount,
              });
            }
            this.logger.log(
              `Background memory summary updated for conversation ${conversationId}`,
            );
          })
          .catch((err: unknown) => {
            this.logger.error(
              `Background summarisation failed for conversation ${conversationId}`,
              err,
            );
          });

        return {
          messages: state.messages.slice(state.messages.length - 2),
        };
      };

      // ── 5. Build and compile the StateGraph ──────────────────────────────────
      const workflow = new StateGraph(AgentState)
        .addNode('classify_intent', classifyIntent)
        .addNode('model_node', modelNode)
        .addNode('init_booking', initBookingNode)
        .addNode('structured_booking_step', structuredBookingStepNode)
        .addNode('tools', toolNode)
        .addNode('parse_tools', parseTools)
        .addNode('system_question', systemQuestionNode)
        .addNode('out_of_scope', outOfScopeNode)
        .addNode('abandon_booking', abandonBookingNode)
        .addNode('search_knowledge', searchKnowledgeNode)
        .addNode('knowledge_fallback', knowledgeFallbackNode)
        .addNode('cancel_booking', cancelBookingNode)
        .addNode('abort_cancel_flow', abortCancelFlowNode)
        .addNode('request_handoff', requestHandoff)
        .addNode('summarize_memory', summarizeMemory);

      // Edges
      workflow.addEdge(START, 'classify_intent');

      workflow.addConditionalEdges(
        'classify_intent',
        (state) => state.intent ?? 'small_talk',
        {
          question: 'search_knowledge',
          system_question: 'system_question',
          out_of_scope: 'out_of_scope',
          small_talk: 'model_node',
          book_appointment: 'model_node',
          book_appointment_init: 'init_booking',
          structured_booking_step: 'structured_booking_step',
          booking_slot_selected: 'model_node',
          confirm_booking: 'model_node',
          check_booking: 'model_node',
          cancel_booking: 'cancel_booking',
          abort_cancel_flow: 'abort_cancel_flow',
          abandon_booking: 'abandon_booking',
          request_human: 'request_handoff',
        },
      );

      workflow.addConditionalEdges(
        'abort_cancel_flow',
        (state) =>
          state.switchTopicAfterAbort ? 'classify_intent' : 'summarize_memory',
        {
          classify_intent: 'classify_intent',
          summarize_memory: 'summarize_memory',
        },
      );

      workflow.addEdge('cancel_booking', 'summarize_memory');
      workflow.addEdge('structured_booking_step', 'summarize_memory');

      const customToolsCondition = (
        state: typeof AgentState.State,
      ): 'tools' | typeof END => {
        const lastMessage = state.messages[state.messages.length - 1];
        const hasToolCalls =
          lastMessage &&
          'tool_calls' in lastMessage &&
          Array.isArray((lastMessage as AIMessage).tool_calls) &&
          ((lastMessage as AIMessage).tool_calls?.length ?? 0) > 0;

        const toolCalls = hasToolCalls
          ? (lastMessage as AIMessage).tool_calls
          : [];

        console.log('[toolsCondition] Evaluated after model_node:', {
          hasToolCalls: !!hasToolCalls,
          toolCallsCount: toolCalls?.length || 0,
          toolNames: toolCalls?.map((tc) => tc.name) || [],
          decision: hasToolCalls ? 'tools' : '__end__',
        });

        return hasToolCalls ? 'tools' : END;
      };

      workflow.addConditionalEdges('model_node', customToolsCondition, {
        tools: 'tools',
        __end__: 'summarize_memory',
      });

      workflow.addEdge('tools', 'parse_tools');
      workflow.addEdge('search_knowledge', 'parse_tools');
      workflow.addConditionalEdges(
        'parse_tools',
        (state) =>
          state.intent === 'question' && state.knowledgeSearchStatus === 'error'
            ? 'knowledge_fallback'
            : 'model_node',
        {
          knowledge_fallback: 'knowledge_fallback',
          model_node: 'model_node',
        },
      );
      workflow.addEdge('system_question', 'summarize_memory');
      workflow.addEdge('out_of_scope', 'summarize_memory');
      workflow.addEdge('abandon_booking', 'summarize_memory');
      workflow.addEdge('init_booking', 'summarize_memory');
      workflow.addEdge('knowledge_fallback', 'summarize_memory');
      workflow.addEdge('cancel_booking', 'summarize_memory');
      workflow.addEdge('request_handoff', 'summarize_memory');
      workflow.addEdge('summarize_memory', END);

      const app = workflow.compile();

      // ── 6. Invoke the graph ──────────────────────────────────────────────────
      const finalState = await app.invoke({
        messages: langchainMessages,
        siteId,
        conversationId,
        visitorContext: options.visitorContext ?? {},
        siteContext: options.siteContext ?? {},
        intent: null,
        locale: resolveEffectiveLocale({
          activeFlowLocale,
          currentLocale,
        }),
        activeFlow,
        activeFlowLocale,
        cancelState: options.initialCancelState ?? {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: existingSummary,
        summarizedMessageCount: existingSummarizedMessageCount,
      });

      // ── 7. Extract last meaningful AI message and persist via onFinish ────────
      console.log(
        `finalState.messages::: ${JSON.stringify(finalState.messages)}`,
      );
      const lastAiMessage = finalState.messages
        .slice()
        .reverse()
        .find((m: BaseMessage) => {
          if (!m.constructor?.name?.includes('AIMessage')) return false;
          const content = m.content;
          if (!content) return false;
          if (typeof content === 'string' && content.trim().length === 0)
            return false;
          if (
            Array.isArray(content) &&
            content.every((c: { type?: string }) => c.type !== 'text')
          )
            return false;
          return true;
        });

      if (lastAiMessage?.content) {
        console.log(`lastAiMessage::: ${JSON.stringify(lastAiMessage)}`);
        const textContent =
          typeof lastAiMessage.content === 'string'
            ? lastAiMessage.content
            : (lastAiMessage.content as { type?: string; text?: string }[])
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('');

        const detectedLang = finalState.locale;
        const bookingChipsAllowed = isBookingFlowIntent(finalState.intent);
        const modelText = enforceBookingChipScope(
          stripReasoningContent(textContent).replace(
            /\s*\[cancel:[^\]]+\]/g,
            '',
          ),
          finalState.intent,
        );
        const components = bookingChipsAllowed
          ? buildChatMessageComponents(
              modelText,
              options.siteContext,
              options.visitorContext,
              new Date(),
              latestUserText,
              hasStructuredBookingProgress ? null : 'service',
            )
          : [];
        const sanitizedText = stripModelBookingDirectives(modelText).trim();
        const componentItems = components[0]?.items ?? [];
        const componentStep = componentItems.some(
          ({ action }) => action === 'select_service',
        )
          ? 'service'
          : componentItems.some(({ action }) => action === 'select_resource')
            ? 'resource'
            : componentItems.some(({ action }) => action === 'select_date')
              ? 'date'
              : componentItems.some(({ action }) => action === 'skip_email')
                ? 'email'
                : componentItems.some(({ action }) => action === 'submit_text')
                  ? 'name'
                  : null;
        const fallbackText = componentStep
          ? getBookingOptionPrompt(
              detectedLang,
              componentStep,
              options.siteContext?.industryTemplateId,
            )
          : '';
        const finalResponseText = bookingSlotsEmitted
          ? stripRenderedSlotTimes(sanitizedText) ||
            getSlotCardPrompt(detectedLang)
          : sanitizedText || fallbackText;

        if (finalResponseText) {
          const bookingMetadata = createdBookingCode
            ? bookingCodeText(createdBookingCode)
            : cancelledBookingCode
              ? `\n<booking-cancelled>${cancelledBookingCode}</booking-cancelled>`
              : '';

          const cancelMetadata =
            finalState.cancelState?.step !== null &&
            finalState.cancelState?.step !== undefined
              ? `\n[cancel:${finalState.cancelState.step}|${finalState.cancelState.bookingCode ?? ''}]`
              : '';
          await onFinish(
            `${finalResponseText}${bookingMetadata}${cancelMetadata}`,
            finalState.knowledgeSources,
            detectedLang,
            components,
          );
          if (res && streamedTokensCount === 0 && !res.writableEnded) {
            res.write(`${sanitizedText}${bookingMetadata}`);
          }
        }
      }

      // ── 8. End the HTTP SSE stream and cleanup MCP Client ─────────────────────
      if (toolProvider?.disconnect) {
        await toolProvider.disconnect();
      }
      if (res) {
        res.end();
      }

      // ── 9. Signal WebSocket that AI response is complete ─────────────────────
      server.to(`conversation-${conversationId}`).emit('aiMessageComplete', {
        conversationId,
      });

      return {
        newSummary:
          finalState.summary !== existingSummary
            ? finalState.summary
            : undefined,
        newSummarizedMessageCount:
          finalState.summarizedMessageCount !== existingSummarizedMessageCount
            ? finalState.summarizedMessageCount
            : undefined,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isAuthError =
        errMsg.includes('401') ||
        errMsg.includes('Incorrect API key') ||
        errMsg.includes('invalid_api_key') ||
        errMsg.includes('MODEL_AUTHENTICATION');

      if (isAuthError) {
        this.logger.warn(
          `LangGraph LLM authentication issue on site ${options.site?.id ?? 'unknown'}: ${errMsg.slice(0, 150)}`,
        );
      } else {
        this.logger.error(
          `LangGraph workflow error: ${errMsg}`,
          error instanceof Error ? error.stack : undefined,
        );
      }

      const fallbackMsg =
        "I'm currently unable to process your request. Please try again or contact support.";

      // Best-effort: write fallback to HTTP and WebSocket
      try {
        if (toolProvider && toolProvider.disconnect) {
          await toolProvider.disconnect();
        }
        if (res) {
          res.write(fallbackMsg);
        }
        server
          .to(`conversation-${conversationId}`)
          .emit('aiChunk', { token: fallbackMsg, conversationId });
        await onFinish(fallbackMsg);
        if (res) {
          res.end();
        }
        server
          .to(`conversation-${conversationId}`)
          .emit('aiMessageComplete', { conversationId });
      } catch {
        // Swallow — response may already be closed
      }

      return {};
    }
  }
}
