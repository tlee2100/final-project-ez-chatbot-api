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
  CancelPrompts,
  CancelState,
  CancelStep,
  getCancelPrompts,
  getIntentClassifierPrompt,
} from './prompts';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { formatInTimeZone } from 'date-fns-tz';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
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
import { Booking } from '../booking/entities/booking.entity';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import {
  extractBookingCode,
  latestActiveBookingCode,
  extractPhoneFromText,
  normalizePhone,
} from './booking-cancellation.utils';
import {
  bookingCodeText,
  bookAppointmentToolNames,
  cleanMixedLanguageResponse,
  detectConversationLanguage,
  extractRequestedTimeSlot,
  isDraftBookingAbandonment,
  isBookingPhonePrompt,
  isBookingSlotSelection,
  isTimeSlotAvailable,
  parseBookingSlotSelection,
  parseMultimodalContent,
  replacePseudoToolResponse,
  sanitizeBookingChips,
  sanitizeSmallTalkResponse,
} from './chat-flow.utils';
import { AdminTestStreamDto } from './dto/admin-test-stream.dto';
// ─── Agent State ──────────────────────────────────────────────────────────────

/** Intent categories the classifier node can assign */
type IntentType =
  | 'question'
  | 'request_human'
  | 'small_talk'
  | 'book_appointment'
  | 'booking_slot_selected'
  | 'check_booking'
  | 'cancel_booking'
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
  visitorContext: Annotation<{ name?: string; email?: string }>({
    reducer: (_, y) => y,
    default: () => ({}),
  }),
  siteContext: Annotation<{
    name?: string;
    domains?: string[];
    bookingEnabled?: boolean;
    bookingServices?: { id: string; name: string }[];
    bookingResources?: { id: string; name: string }[];
    bookingHours?: {
      timezone?: string | null;
      availableDays?: number[];
      startTime?: string;
      endTime?: string;
      slotDuration?: number;
    };
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
});

// ─── Run Options ─────────────────────────────────────────────────────────────

export interface GraphRunOptions {
  /** Conversation history to process */
  messages: LLMMessage[];
  /** Site UUID for scoping tool calls */
  siteId: string;
  /** Conversation UUID for context injection */
  conversationId: string;
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
    bookingServices?: { id: string; name: string }[];
    bookingResources?: { id: string; name: string }[];
    bookingHours?: {
      timezone?: string | null;
      availableDays?: number[];
      startTime?: string;
      endTime?: string;
      slotDuration?: number;
    };
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
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
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
      const site = await this.siteRepo.findOne({
        where: { id: siteId },
        relations: {
          industryTemplateInfo: true,
          bookingConfig: true,
          bookingServices: true,
          bookingResources: true,
        },
      });

      if (!this.testSessionMessages.has(conversationId)) {
        this.testSessionMessages.set(conversationId, []);
      }
      const history = this.testSessionMessages.get(conversationId)!;
      if (newTestMessageContent) {
        history.push({ role: 'user', content: newTestMessageContent });
      }

      const onFinish = (text: string): Promise<void> => {
        history.push({ role: 'assistant', content: text });
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('newMessage', {
            id: `ai-msg-${Date.now()}`,
            conversationId,
            content: text,
            senderType: 'AI',
            createdAt: new Date().toISOString(),
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

    const [conversation, site] = await Promise.all([
      this.chatService.getConversationById(conversationId),
      this.siteRepo.findOne({
        where: { id: siteId },
        relations: {
          industryTemplateInfo: true,
          bookingConfig: true,
          bookingServices: true,
          bookingResources: true,
        },
      }),
    ]);

    const dbMessages = await this.chatService.getMessagesForConversation(
      conversationId,
      undefined,
      '30',
    );

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

    const onFinish = async (text: string) => {
      console.log(`text to save ${text}`);
      const savedMessage = await this.chatService.saveMessage(
        conversationId,
        text,
        SenderType.AI,
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
    const latestUserText =
      messages
        .slice()
        .reverse()
        .find((message) => message.role === 'user')?.content ?? '';
    const requestedTimeSlot = extractRequestedTimeSlot(latestUserText);
    const selectedFromWidget = isBookingSlotSelection(latestUserText);
    let requestedSlotAvailability: boolean | undefined;

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
            schema: z.object(this.buildZodSchema(def.schema)),
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
                const service =
                  services.find((item) => item.id === args.serviceId) ??
                  services.find((item) =>
                    userMessages.includes(item.name.toLowerCase()),
                  );
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

                toolArgs = {
                  ...args,
                  serviceId: service?.id ?? args.serviceId,
                  resourceId: resource?.id ?? args.resourceId,
                  date: args.date ?? slotSelection?.date,
                  timeSlot: args.timeSlot ?? slotSelection?.timeSlot,
                };

                if (!resource) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. A specific staff/resource must be selected before booking. Ask the user to choose one available staff member, or choose one available staff member from the selected slot and state it clearly.',
                  });
                }

                if (!service) {
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. A valid service from the current site must be selected before booking.',
                  });
                }

                if (def.name === 'draftBooking') {
                  const bookingLanguage = detectConversationLanguage(
                    messages,
                    options.siteContext,
                  );
                  this.logger.log(
                    `[Tool Node] Executing tool: draftBooking -> emitting bookingSummary card`,
                  );
                  this.chatGateway.emitBookingSummary(conversationId, {
                    ...toolArgs,
                    serviceName: service?.name ?? args.serviceName,
                    resourceName: resource?.name ?? args.resourceName,
                    saveChangesLabel:
                      bookingLanguage === 'vi'
                        ? 'Lưu thay đổi'
                        : 'Save changes',
                  });
                  return JSON.stringify({
                    success: true,
                    draftReady: true,
                    message:
                      'The booking summary card has been displayed on the widget for customer review and confirmation. Ask the visitor in one short, polite sentence to review and confirm on the card below.',
                  });
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
                    serviceName: service.name,
                    resourceName: resource.name,
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
          question: [
            'getConversationContext',
            'getSiteConfig',
            'searchKnowledge',
          ],
          book_appointment: bookAppointmentToolNames(latestUserText),
          booking_slot_selected: [
            'getSiteConfig',
            'holdSlot',
            'releaseHold',
            'draftBooking',
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

      const isCancelBookingPhrase = (text: string) =>
        /(?:hủy|cancel|không\s+(?:muốn\s+)?(?:đi|đến|làm|tới)|không\s+(?:đi|đến|tới)\s+được|bỏ\s+lịch|bỏ\s+hẹn|ngưng|dừng)/i.test(
          text,
        );

      const isAffirmativePhrase = (text: string) =>
        /^(?:ừ|u|uh|uk|ừm|um|uhm|dạ|da|vâng|vang|yep|yeah|ye|ok|oke|okay|đồng ý|dong y|dong tinh|đồng tình|xác nhận|xac nhan|hủy|cancel|chắc chắn|yes|y|cứ hủy|chuẩn|đúng|dung|chính xác)[\s!.]*$/i.test(
          text.trim(),
        );

      const isAskingCancellationConfirmation = (text: string) =>
        /(?:hủy lịch|xác nhận hủy|xác nhận muốn hủy|muốn hủy|tiến hành hủy|confirm.*cancel|kiểm tra và xác nhận hủy)/i.test(
          text,
        );

      const isBookingContinuation = (
        state: typeof AgentState.State,
        userText: string,
      ) => {
        if (state.siteContext.bookingEnabled !== true) return false;

        // If cancel flow is active or user explicitly wants to cancel, DO NOT treat as booking continuation
        if (
          state.cancelState?.step !== null &&
          state.cancelState?.step !== undefined
        ) {
          return false;
        }

        if (
          /^\/(?:confirm-)?cancel-booking\b/i.test(userText) ||
          isCancelBookingPhrase(userText)
        ) {
          return false;
        }

        const previousAssistant = state.messages
          .slice(0, -1)
          .reverse()
          .find((message) => message.constructor?.name?.includes('AIMessage'));
        if (!previousAssistant) return false;

        const assistantText = messageText(previousAssistant);

        // If assistant was asking about cancellation, NOT booking continuation
        if (
          isAskingCancellationConfirmation(assistantText) ||
          /\[cancel:\w+/i.test(assistantText) ||
          /xác nhận danh tính|verify your identity/i.test(assistantText)
        ) {
          return false;
        }

        const chips = assistantText
          .match(/<chips>(.*?)<\/chips>/)?.[1]
          .split('|')
          .map((chip) => chip.trim().toLowerCase());
        if (chips?.includes(userText.trim().toLowerCase())) return true;

        // User expresses intent to change/edit
        if (
          /\b(change|update|set|edit|sửa|thay đổi|đổi)\b/i.test(userText) ||
          /^\b(service|stylist|staff|date|time|name|phone|email|dịch vụ|nhân viên|ngày|giờ|tên|sđt|số điện thoại)\b$/i.test(
            userText.trim(),
          )
        ) {
          return true;
        }

        // Assistant was asking what to change or asking for field values during edit
        if (
          /(?:what would you like to change|what.*change|bạn muốn.*(thay đổi|đổi|sửa)|which detail|enter.*email|nhập.*email|email mới|new email|số điện thoại mới|new phone|tên mới|new name|ngày mới|new date|giờ mới|new time)/i.test(
            assistantText,
          )
        ) {
          return true;
        }

        if (assistantText.includes('<chips>')) {
          return true;
        }

        return /(which service|service|stylist|staff|resource|what date|date|available time|select.*time|time slot|phone number|phone|confirmation email|email|what'?s your name|name|dịch vụ|thợ|nhân viên|ngày|giờ|khung giờ|số điện thoại|sđt|tên|email xác nhận|summary card|booking summary|thông tin đặt lịch|review.*card|xem lại)/i.test(
          assistantText,
        );
      };

      // ── 4. Define graph nodes ────────────────────────────────────────────────

      /**
       * classify_intent — uses a cold model call to label the latest user message.
       */
      const classifyIntent = async (state: typeof AgentState.State) => {
        if (
          state.cancelState?.step !== null &&
          state.cancelState?.step !== undefined
        ) {
          this.logger.log(
            `Cancel flow in progress (step: ${state.cancelState.step}), overriding intent to cancel_booking`,
          );
          return { intent: 'cancel_booking' as IntentType };
        }

        const lastMessage = state.messages[state.messages.length - 1];
        const contentStr =
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
        const bookingEnabled = state.siteContext.bookingEnabled === true;

        // ── 1. Fast-Path Check (Deterministic routing without LLM call) ──
        const previousAssistantText = state.messages
          .slice(0, -1)
          .reverse()
          .find((message) => message.constructor?.name?.includes('AIMessage'));
        const previousAssistantContent = previousAssistantText
          ? messageText(previousAssistantText)
          : '';
        const isCancelCodeReply =
          !!extractBookingCode(contentStr) &&
          !!previousAssistantText &&
          /(booking code|confirmation code|mã.*(?:đặt lịch|xác nhận))/i.test(
            previousAssistantContent,
          );

        if (/^\/(?:update-draft-booking|confirm-booking)\b/i.test(contentStr)) {
          this.logger.log('[Fast-Path Intent] book_appointment');
          return { intent: 'book_appointment' as IntentType };
        }

        if (isBookingSlotSelection(contentStr)) {
          this.logger.log('[Fast-Path Intent] booking_slot_selected');
          return { intent: 'booking_slot_selected' as IntentType };
        }

        if (isDraftBookingAbandonment(contentStr)) {
          this.logger.log('[Fast-Path Intent] abandoned booking -> small_talk');
          return { intent: 'small_talk' as IntentType };
        }

        const isCancelIntent =
          /^\/(?:confirm-)?cancel-booking\b/i.test(contentStr) ||
          isCancelBookingPhrase(contentStr) ||
          (isAskingCancellationConfirmation(previousAssistantContent) &&
            isAffirmativePhrase(contentStr)) ||
          isCancelCodeReply;

        if (isCancelIntent) {
          this.logger.log('[Fast-Path Intent] cancel_booking');
          return { intent: 'cancel_booking' as IntentType };
        }

        // Check if user is explicitly asking for a human agent
        const isAskingForHuman =
          /\b(?:human|agent|support|tư vấn viên|gặp người|nói chuyện với người|trợ giúp trực tiếp)\b/i.test(
            contentStr,
          );

        if (!isAskingForHuman && isBookingContinuation(state, contentStr)) {
          this.logger.log('[Fast-Path Intent] book_appointment');
          return { intent: 'book_appointment' as IntentType };
        }

        // Fast-path for common greetings and small talk
        const isGreetingOrThanks =
          /^(?:hi|hello|hey|hola|chào|chào bạn|chào shop|chào ad|alo|cảm ơn|cảm ơn bạn|thanks|thank you)[\s!.]*$/i.test(
            contentStr.trim(),
          );
        if (isGreetingOrThanks) {
          this.logger.log('[Fast-Path Intent] small_talk');
          return { intent: 'small_talk' as IntentType };
        }

        // ── 2. LLM Intent Classifier (Fallback for open questions & ambiguous messages) ──
        const intents = bookingEnabled
          ? ([
              'question',
              'request_human',
              'small_talk',
              'book_appointment',
              'check_booking',
              'cancel_booking',
            ] as const)
          : (['question', 'request_human', 'small_talk'] as const);

        const intentSchema = z.object({
          intent: z.enum(intents).catch('small_talk'),
          sentiment: z
            .enum(['positive', 'neutral', 'negative'])
            .catch('neutral'),
        });

        const model = this.aiService
          .buildModelForSite(options.site ?? {}, 0, false)
          .withStructuredOutput(intentSchema);

        try {
          const response = await model.invoke([
            new SystemMessage(getIntentClassifierPrompt(bookingEnabled)),
            new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
          ]);

          this.logger.log(
            `Intent classified: ${response.intent}, Sentiment: ${response.sentiment}`,
          );

          const intent = isBookingSlotSelection(contentStr)
            ? 'booking_slot_selected'
            : /^\/(?:(?:confirm-)?cancel-booking|keep-booking)\b/i.test(
                  contentStr,
                ) || isCancelCodeReply
              ? 'cancel_booking'
              : isBookingContinuation(state, contentStr)
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

          return { intent: intent as IntentType };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Intent classification fallback for site ${options.site?.id ?? 'unknown'}: ${errMsg.slice(0, 150)}`,
          );
          return { intent: 'small_talk' as IntentType };
        }
      };

      /**
       * request_handoff — updates the conversation status, notifies agents,
       * and writes a canned handoff message.
       */
      const requestHandoff = async () => {
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

      const buildCancellationPayload = (booking: Booking) => ({
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

      const getLatestUserText = (state: typeof AgentState.State): string => {
        const msg = [...state.messages]
          .reverse()
          .find((m) => m.constructor?.name?.includes('HumanMessage'));
        return msg ? messageText(msg) : '';
      };

      const handleAskCode = async (
        state: typeof AgentState.State,
        userText: string,
        _isVietnamese: boolean,
        prompts: CancelPrompts,
      ) => {
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
            messages: [new AIMessage(`${prompts.askCode} [cancel:ask_code|]`)],
          };
        }

        const booking = await this.bookingRepo.findOne({
          where: { siteId: state.siteId, code: bookingCode },
        });

        if (!booking) {
          return {
            cancelState: {
              step: null,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(prompts.notFound)],
          };
        }

        if (booking.status === BookingStatus.CANCELLED) {
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
              `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]`,
            ),
          ],
        };
      };

      const handleVerifyPhone = async (
        state: typeof AgentState.State,
        userText: string,
        _isVietnamese: boolean,
        prompts: CancelPrompts,
      ) => {
        const { bookingCode } = state.cancelState;

        if (!bookingCode) {
          return {
            cancelState: {
              step: 'ask_code' as CancelStep,
              bookingCode: null,
              phoneVerified: false,
            },
            messages: [new AIMessage(`${prompts.askCode} [cancel:ask_code|]`)],
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
                  _isVietnamese
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
                _isVietnamese
                  ? 'Lịch đặt thử nghiệm của bạn đã được hủy.'
                  : 'Your test booking has been cancelled.',
              ),
            ],
          };
        }

        const booking = await this.bookingRepo.findOne({
          where: { siteId: state.siteId, code: bookingCode },
          relations: { service: true, resource: true },
        });

        if (!booking) {
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
                `${prompts.verifyPhone} [cancel:verify_phone|${bookingCode}]`,
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
                `${prompts.phoneWrong} [cancel:verify_phone|${bookingCode}]`,
              ),
            ],
          };
        }

        const payload = buildCancellationPayload(booking);
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
        _isVietnamese: boolean,
        prompts: CancelPrompts,
      ) => {
        const { bookingCode } = state.cancelState;

        if (/^\/keep-booking\b/i.test(userText)) {
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
          const booking = await this.bookingRepo.findOne({
            where: { siteId: state.siteId, code: bookingCode },
            relations: { service: true, resource: true },
          });
          if (booking) {
            this.chatGateway.emitBookingCancelled(conversationId, {
              ...buildCancellationPayload(booking),
              ...resultOutput,
            });
          }

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
          const booking = await this.bookingRepo.findOne({
            where: { siteId: state.siteId, code: bookingCode },
            relations: { service: true, resource: true },
          });
          if (booking) {
            this.chatGateway.emitBookingCancellation(
              conversationId,
              buildCancellationPayload(booking),
            );
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
        const convertedMessages = state.messages.map((m) => ({
          role: m.constructor?.name?.includes('HumanMessage')
            ? 'user'
            : 'assistant',
          content: messageText(m),
        }));
        const detectedLang = detectConversationLanguage(
          convertedMessages,
          state.siteContext,
          true,
        );
        const isVietnamese = detectedLang === 'vi';
        const prompts = getCancelPrompts(isVietnamese);

        switch (state.cancelState?.step) {
          case 'verify_phone':
            return handleVerifyPhone(state, userText, isVietnamese, prompts);
          case 'await_confirm':
            return handleConfirmExecute(state, userText, isVietnamese, prompts);
          default:
            return handleAskCode(state, userText, isVietnamese, prompts);
        }
      };

      const bookingSlotSelectedNode = (state: typeof AgentState.State) => {
        const convertedMessages = state.messages.map((m) => ({
          role: m.constructor?.name?.includes('HumanMessage')
            ? 'user'
            : 'assistant',
          content: messageText(m),
        }));
        const detectedLang = detectConversationLanguage(
          convertedMessages,
          state.siteContext,
        );
        const isVietnamese = detectedLang === 'vi';
        const nameQuestion = isVietnamese
          ? 'Bạn tên là gì?'
          : "What's your name?";
        const nameChips = state.visitorContext?.name
          ? `\n\n<chips>${state.visitorContext.name}</chips>`
          : '';
        return {
          messages: [new AIMessage(`${nameQuestion}${nameChips}`)],
        };
      };

      /**
       * model_node — invokes the bound LLM with tools, streaming tokens to both
       * the HTTP response (visitor) and the WebSocket room (admin dashboard).
       */
      const modelNode = async (state: typeof AgentState.State) => {
        const isSmallTalk = state.intent === 'small_talk';
        const promptSiteContext = isSmallTalk
          ? {
              name: state.siteContext.name,
              domains: state.siteContext.domains,
            }
          : state.siteContext;
        const convertedMessages: LLMMessage[] = state.messages.map((m) => ({
          role: m.constructor?.name?.includes('HumanMessage')
            ? ('user' as const)
            : ('assistant' as const),
          content: messageText(m),
        }));
        let systemPrompt = this.aiService.buildSystemPrompt(
          {
            messages: convertedMessages,
            summary: state.summary,
            siteId: state.siteId,
            conversationId: state.conversationId,
            visitorContext: state.visitorContext,
            siteContext: promptSiteContext,
            systemPromptOverride: options.systemPromptOverride,
          },
          state.intent !== 'book_appointment',
        );
        if (isSmallTalk) {
          systemPrompt +=
            '\n\nCurrent intent: small talk. Reply briefly to the user message. Do not mention or list booking services, staff, resources, availability, or booking options. Do not output chips or call tools.';
        }

        const messagesWithSystem = [
          new SystemMessage(systemPrompt),
          ...state.messages,
        ];
        const visibleTools = toolsForIntent(
          state.intent,
          getLatestUserText(state),
        );
        this.logger.log(
          `[Tool Binding] intent=${state.intent ?? 'unknown'} tools=${visibleTools.map((tool) => tool.name).join(', ')}`,
        );
        const shouldStream = state.intent !== 'book_appointment';
        const temperature = state.intent === 'book_appointment' ? 0.0 : 0.2;
        const boundModel = this.aiService
          .buildModelForSite(
            options.site ?? {},
            temperature,
            shouldStream,
            options.maxTokensPerResponse,
          )
          .bindTools(visibleTools);

        let response;
        try {
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
          const isAuthOrQuota =
            errMsg.includes('401') ||
            errMsg.includes('Incorrect API key') ||
            errMsg.includes('invalid_api_key') ||
            errMsg.includes('429') ||
            errMsg.includes('insufficient_quota') ||
            errMsg.includes('MODEL_AUTHENTICATION');

          if (isAuthOrQuota && options.site?.useCustomOpenAiKey) {
            this.logger.warn(
              `Custom OpenAI key on site ${options.site?.id ?? 'unknown'} failed (${errMsg.slice(0, 100)}). Gracefully falling back to system master key...`,
            );
            const fallbackModel = this.aiService
              .buildModel(
                temperature,
                shouldStream,
                options.maxTokensPerResponse,
              )
              .bindTools(visibleTools);

            response = await fallbackModel.invoke(messagesWithSystem, {
              callbacks: [
                {
                  handleLLMNewToken(token: string) {
                    if (!shouldStream) return;
                    if (token) {
                      streamedTokensCount++;
                      if (res) {
                        res.write(token);
                      }
                      server
                        .to(`conversation-${conversationId}`)
                        .emit('aiChunk', { token, conversationId });
                    }
                  },
                },
              ],
            });
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
      const parseTools = (state: typeof AgentState.State) => {
        const calledTools = state.messages
          .filter((m) => m.constructor?.name?.includes('ToolMessage') || m.name)
          .map((m) => m.name)
          .filter(Boolean);
        this.logger.log(
          `[Parse Tools] Tools called: ${Array.from(new Set(calledTools)).join(', ')}`,
        );

        const lastMessage = state.messages[state.messages.length - 1];

        if (lastMessage instanceof ToolMessage) {
          try {
            const rawContent =
              typeof lastMessage.content === 'string'
                ? lastMessage.content
                : JSON.stringify(lastMessage.content);
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(rawContent);
            } catch {
              parsed = null;
            }

            if (!parsed) {
              return {};
            }

            // Handle booking tools interception
            if (lastMessage.name?.includes('getAvailableSlots')) {
              if (!requestedTimeSlot) {
                this.chatGateway.emitBookingSlots(conversationId, parsed);
              }
            } else if (lastMessage.name?.includes('createBooking')) {
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
                this.chatGateway.emitBookingSuccess(conversationId, parsed);
              }
            }

            // Handle searchKnowledge
            if (lastMessage.name?.includes('searchKnowledge')) {
              let results: unknown[] = [];
              if (Array.isArray(parsed)) {
                results = parsed;
              } else if (
                parsed &&
                typeof parsed === 'object' &&
                'chunks' in parsed &&
                Array.isArray((parsed as Record<string, unknown>).chunks)
              ) {
                results = (parsed as Record<string, unknown>)
                  .chunks as unknown[];
              }

              const sourcesMap = new Map<
                string,
                { filename: string; sourceUrl?: string }
              >();
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
              const knowledgeSources = Array.from(sourcesMap.entries()).map(
                ([documentId, source]) => ({ documentId, ...source }),
              );
              return { knowledgeSources };
            }
          } catch (error) {
            this.logger.error('Failed to parse tool output', error);
          }
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
        .addNode('tools', toolNode)
        .addNode('parse_tools', parseTools)
        .addNode('booking_slot_selected', bookingSlotSelectedNode)
        .addNode('cancel_booking', cancelBookingNode)
        .addNode('request_handoff', requestHandoff)
        .addNode('summarize_memory', summarizeMemory);

      // Edges
      workflow.addEdge(START, 'classify_intent');

      workflow.addConditionalEdges(
        'classify_intent',
        (state) => state.intent ?? 'small_talk',
        {
          question: 'model_node',
          small_talk: 'model_node',
          book_appointment: 'model_node',
          booking_slot_selected: 'booking_slot_selected',
          check_booking: 'model_node',
          cancel_booking: 'cancel_booking',
          request_human: 'request_handoff',
        },
      );

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
      workflow.addEdge('parse_tools', 'model_node');
      workflow.addEdge('booking_slot_selected', 'summarize_memory');
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
        cancelState: options.initialCancelState ?? {
          step: null,
          bookingCode: null,
          phoneVerified: false,
        },
        knowledgeSources: [],
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

        const convertedMessages: LLMMessage[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const detectedLang = detectConversationLanguage(
          convertedMessages,
          options.siteContext,
          finalState.intent !== 'book_appointment' &&
            finalState.intent !== 'booking_slot_selected',
        );
        const isVietnamese = detectedLang === 'vi';
        const strippedText = textContent
          .replace(/\s*\[cancel:[^\]]+\]/g, '')
          .trim();

        const intentSafeText =
          finalState.intent === 'small_talk'
            ? sanitizeSmallTalkResponse(
                strippedText,
                isVietnamese,
                options.siteContext,
              )
            : sanitizeBookingChips(
                strippedText,
                options.siteContext,
                options.visitorContext,
                detectedLang,
              );
        const cleanLangText = cleanMixedLanguageResponse(
          intentSafeText,
          isVietnamese,
        );
        const sanitizedText = replacePseudoToolResponse(
          cleanLangText,
          isVietnamese,
        );

        if (sanitizedText.trim()) {
          const finalResponseText =
            requestedTimeSlot && requestedSlotAvailability === false
              ? isVietnamese
                ? 'Khung giờ bạn chọn hiện không khả dụng. Vui lòng bắt đầu đặt lịch lại từng bước để chọn khung giờ khác.'
                : 'The requested time slot is unavailable. Please restart the booking step by step to choose another time.'
              : createdBookingCode
                ? isVietnamese
                  ? 'Lịch hẹn của bạn đã được xác nhận!'
                  : 'Your appointment is confirmed!'
                : sanitizedText;
          const bookingMetadata = createdBookingCode
            ? bookingCodeText(createdBookingCode, isVietnamese)
            : cancelledBookingCode
              ? `\n<booking-cancelled>${cancelledBookingCode}</booking-cancelled>`
              : '';
          const bookingInputMetadata =
            finalState.intent === 'book_appointment' &&
            isBookingPhonePrompt(sanitizedText)
              ? '\n<booking-input>phone</booking-input>'
              : '';

          const cancelMetadata =
            finalState.cancelState?.step !== null &&
            finalState.cancelState?.step !== undefined
              ? `\n[cancel:${finalState.cancelState.step}|${finalState.cancelState.bookingCode ?? ''}]`
              : '';

          await onFinish(
            `${finalResponseText}${bookingInputMetadata}${bookingMetadata}${cancelMetadata}`,
            finalState.knowledgeSources,
          );
          if (res && streamedTokensCount === 0 && !res.writableEnded) {
            res.write(`${sanitizedText}${bookingMetadata}`);
          }
        }
      }

      // ── 8. End the HTTP SSE stream and cleanup MCP Client ─────────────────────
      if (toolProvider.disconnect) {
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Converts a raw JSON Schema properties object to a Zod schema for DynamicStructuredTool.
   */
  private buildZodSchema(
    schema: Record<string, unknown>,
  ): Record<string, z.ZodTypeAny> {
    const zodFields: Record<string, z.ZodTypeAny> = {};
    const properties = (
      schema as { properties?: Record<string, { type?: string }> }
    ).properties;
    const required = (schema as { required?: string[] }).required ?? [];

    if (properties) {
      for (const [key, def] of Object.entries(properties)) {
        let zodType: z.ZodTypeAny =
          def.type === 'number' ? z.number() : z.string();

        if (!required.includes(key)) {
          zodType = zodType.optional();
        }

        zodFields[key] = zodType;
      }
    }

    return zodFields;
  }
}
