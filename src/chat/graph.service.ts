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
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { getIntentClassifierPrompt } from './prompts';
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
import {
  extractBookingCode,
  latestActiveBookingCode,
} from './booking-cancellation.utils';
import {
  isBookingSlotSelection,
  parseBookingSlotSelection,
  replacePseudoToolResponse,
  sanitizeSmallTalkResponse,
} from './chat-flow.utils';
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
  /** Whether sentiment detection is enabled  /** Sentiment Detection */
  sentimentDetection?: boolean;
  /** Callback when negative sentiment is detected by the intent classifier */
  onNegativeSentiment?: (text: string) => Promise<void>;
  /** Flag to prevent duplicate alerts */
  hasNegativeSentiment?: boolean;
}

export interface GraphRunResult {
  newSummary?: string;
  newSummarizedMessageCount?: number;
}

const isVietnameseText = (text: string) =>
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]|(bạn|tôi|mình|không|ưu tiên|ngày|giờ|dịch vụ|đặt lịch|hủy lịch|nhân viên|vui lòng|chọn|thời gian|phù hợp|cảm ơn)/i.test(
    text,
  );

const sanitizeBookingChips = (
  text: string,
  siteContext?: GraphRunOptions['siteContext'],
) => {
  if (!text.includes('<chips>') || siteContext?.bookingEnabled !== true) {
    return text;
  }

  const noPreference = isVietnameseText(text)
    ? 'Không ưu tiên'
    : 'No Preference';
  const services =
    siteContext.bookingServices?.map((service) => service.name) ?? [];
  const resources =
    siteContext.bookingResources?.map((resource) => resource.name) ?? [];

  if (
    /(what'?s your name|may i have your name|your phone number|phone number|tên.*bạn|bạn.*tên|số điện thoại)/i.test(
      text,
    )
  ) {
    return text.replace(/\s*<chips>.*?<\/chips>/g, '').trim();
  }

  if (/(preferred stylist|stylist|staff|nhân viên)/i.test(text)) {
    const options = [...resources, noPreference].filter(Boolean);
    return options.length
      ? text.replace(
          /<chips>.*?<\/chips>/,
          `<chips>${options.join('|')}</chips>`,
        )
      : text;
  }

  if (/(which service|dịch vụ)/i.test(text)) {
    return services.length
      ? text.replace(
          /<chips>.*?<\/chips>/,
          `<chips>${services.join('|')}</chips>`,
        )
      : text;
  }

  return text;
};

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
 *
 * Graph topology:
 *   START → classify_intent
 *           ├─ request_human → request_handoff → summarize_memory → END
 *           └─ all other intents → model_node
 *                                     ├─ has tool calls → tools → parse_tools → model_node
 *                                     └─ no tool calls  → summarize_memory → END
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

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
   *
   * Used by:
   *  - ChatController.streamAiResponse() — SSE path (res is provided)
   *  - ChatGateway.handleSendMessage()   — WebSocket path (res is undefined)
   *
   * @param conversationId  UUID of the conversation
   * @param siteId          UUID of the site
   * @param server          Socket.io Server for WebSocket fan-out
   * @param onMessageSaved  Called after the AI message is persisted — used by the
   *                        gateway to emit 'newMessage' to the visitor widget.
   * @param res             Optional Express response for HTTP SSE streaming.
   */
  async handleVisitorMessage(
    conversationId: string,
    siteId: string,
    res?: ExpressResponse,
    onNegativeSentiment?: (text: string) => Promise<void>,
  ): Promise<void> {
    const aiEnabled = await this.canRunAi(conversationId, siteId);
    if (!aiEnabled) {
      if (res) res.end();
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

    const onFinish = async (text: string) => {
      const savedMessage = await this.chatService.saveMessage(
        conversationId,
        text,
        SenderType.AI,
      );
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('newMessage', {
          id: savedMessage.id,
          conversationId,
          content: text,
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
      await this.runStream({
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
      });
    } finally {
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('ai-stream-end', { conversationId });
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

    try {
      // ── 1. Build LangChain messages from raw LLMMessage array ──────────────
      const langchainMessages: BaseMessage[] = messages.map((m) => {
        if (m.role === 'user') return new HumanMessage(m.content);
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

              if (def.name === 'createBooking') {
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
                  serviceId: service?.id,
                  resourceId: resource?.id,
                  date: slotSelection?.date ?? args.date,
                  timeSlot: slotSelection?.timeSlot ?? args.timeSlot,
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

                const lastUserMessage = messages
                  .slice()
                  .reverse()
                  .find((m) => m.role === 'user')?.content as string;

                const isConfirmed =
                  lastUserMessage?.includes('/confirm-booking');

                if (!isConfirmed) {
                  this.logger.log(
                    `[Tool Node] Intercepting tool: ${def.name} for confirmation gate`,
                  );
                  this.chatGateway.emitBookingSummary(conversationId, {
                    ...toolArgs,
                    serviceName: service.name,
                    resourceName: resource.name,
                  });
                  return JSON.stringify({
                    error: 'ACTION_REQUIRED',
                    message:
                      'Do not execute. The widget already displayed the booking summary card. Do not repeat booking details, do not add Confirm/Edit chips, and ask the user to review the card in one short sentence only.',
                  });
                }
              }

              this.logger.log(`[Tool Node] Executing tool: ${def.name}`);
              const result = await currentProvider.execute({
                name: def.name,
                arguments: toolArgs,
              });
              return JSON.stringify(result.output);
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

      const toolsForIntent = (intent: IntentType) => {
        const allowedToolNamesByIntent: Partial<
          Record<NonNullable<IntentType>, string[]>
        > = {
          small_talk: [],
          question: [
            'getConversationContext',
            'getSiteConfig',
            'searchKnowledge',
          ],
          book_appointment: [
            'getSiteConfig',
            'getAvailableSlots',
            'createBooking',
          ],
          check_booking: ['getConversationContext'],
        };

        const allowedToolNames = intent
          ? allowedToolNamesByIntent[intent]
          : undefined;

        return allowedToolNames
          ? aiTools.filter((tool) => allowedToolNames.includes(tool.name))
          : aiTools;
      };

      const messageText = (message: BaseMessage) =>
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content);

      const activeConversationBookingCode = async (
        state: typeof AgentState.State,
      ) => {
        const metadataMessages = await this.chatMessageRepo.find({
          where: [
            { conversationId, content: Like('%<booking-code>%') },
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

      const isBookingContinuation = (
        state: typeof AgentState.State,
        userText: string,
      ) => {
        if (state.siteContext.bookingEnabled !== true) return false;

        const previousAssistant = state.messages
          .slice(0, -1)
          .reverse()
          .find((message) => message.constructor?.name?.includes('AIMessage'));
        if (!previousAssistant) return false;

        const assistantText = messageText(previousAssistant);
        const chips = assistantText
          .match(/<chips>(.*?)<\/chips>/)?.[1]
          .split('|')
          .map((chip) => chip.trim().toLowerCase());
        if (chips?.includes(userText.trim().toLowerCase())) return true;
        if (
          /\b(change|update|set)\b.*\b(booking|name|phone|email|date|time|staff|stylist|service)\b/i.test(
            userText,
          ) ||
          /what details.*change|details.*change/i.test(assistantText)
        ) {
          return true;
        }

        return /(which service|preferred stylist|what date|available time|select.*time|phone number|confirmation email|what'?s your name|bạn muốn.*dịch vụ|bạn.*stylist|bạn muốn.*ngày|chọn.*giờ|khung giờ|số điện thoại|tên.*bạn|email xác nhận)/i.test(
          assistantText,
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
          .buildModel(0, false)
          .withStructuredOutput(intentSchema);

        try {
          const response = await model.invoke([
            new SystemMessage(getIntentClassifierPrompt(bookingEnabled)),
            new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
          ]);

          this.logger.log(
            `Intent classified: ${response.intent}, Sentiment: ${response.sentiment}`,
          );

          const previousAssistantText = state.messages
            .slice(0, -1)
            .reverse()
            .find((message) =>
              message.constructor?.name?.includes('AIMessage'),
            );
          const isCancelCodeReply =
            !!extractBookingCode(contentStr) &&
            !!previousAssistantText &&
            /(booking code|confirmation code|mã.*(?:đặt lịch|xác nhận))/i.test(
              messageText(previousAssistantText),
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

              // 1. Fire and forget so we don't block the AI response
              options
                .onNegativeSentiment(contentStr)
                .catch((err: unknown) =>
                  this.logger.error(
                    `Error in onNegativeSentiment callback: ${err instanceof Error ? err.message : String(err)}`,
                    err,
                  ),
                );

              // 2. Mark this conversation as having negative sentiment to prevent duplicate alerts
              await this.conversationRepo.update(options.conversationId, {
                hasNegativeSentiment: true,
              });
            } else {
              this.logger.log(
                `Negative sentiment detected again for conversation ${options.conversationId}, but agents were already alerted.`,
              );
            }
          }

          return { intent: intent as IntentType };
        } catch (error) {
          this.logger.error('Failed to parse structured intent', error);
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

      const cancelBookingNode = async (state: typeof AgentState.State) => {
        const latestUserText = [...state.messages]
          .reverse()
          .find((message) =>
            message.constructor?.name?.includes('HumanMessage'),
          );
        const userText = latestUserText ? messageText(latestUserText) : '';
        const isVietnamese = isVietnameseText(userText);

        if (/^\/keep-booking\b/i.test(userText)) {
          return {
            messages: [
              new AIMessage(
                isVietnamese ? 'Xác nhận giữ lịch!' : 'Keep booking confirmed!',
              ),
            ],
          };
        }

        const bookingCode =
          extractBookingCode(userText) ??
          (await activeConversationBookingCode(state));

        if (!bookingCode) {
          return {
            messages: [
              new AIMessage(
                isVietnamese
                  ? 'Vui lòng cung cấp mã đặt lịch bạn muốn hủy.'
                  : 'Please provide the booking code you want to cancel.',
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
            messages: [
              new AIMessage(
                isVietnamese
                  ? 'Không tìm thấy lịch đặt với mã này.'
                  : 'No booking was found with this code.',
              ),
            ],
          };
        }

        const cancellationPayload = {
          bookingCode: booking.code,
          status: booking.status,
          customerName: booking.customerName,
          phone: booking.phone,
          serviceId: booking.serviceId ?? undefined,
          serviceName: booking.service?.name,
          resourceId: booking.resourceId ?? undefined,
          resourceName: booking.resource?.name,
          date: formatInTimeZone(
            booking.startAt,
            booking.timezone,
            'yyyy-MM-dd',
          ),
          timeSlot: formatInTimeZone(
            booking.startAt,
            booking.timezone,
            'HH:mm',
          ),
        };

        if (!/^\/confirm-cancel-booking\b/i.test(userText)) {
          this.chatGateway.emitBookingCancellation(
            conversationId,
            cancellationPayload,
          );
          return {
            messages: [
              new AIMessage(
                isVietnamese
                  ? 'Vui lòng kiểm tra và xác nhận hủy lịch.'
                  : 'Please review and confirm the booking cancellation.',
              ),
            ],
          };
        }

        this.logger.log('[Tool Node] Executing tool: cancelBooking');
        const result = await currentProvider.execute({
          name: 'cancelBooking',
          arguments: { bookingCode },
        });
        if (result.output.status !== 'cancelled') {
          const error = result.output.error ?? result.output.result;
          return {
            messages: [
              new AIMessage(
                typeof error === 'string'
                  ? error
                  : isVietnamese
                    ? 'Không thể hủy lịch này. Vui lòng kiểm tra lại mã đặt lịch.'
                    : 'Unable to cancel this booking. Please check the booking code.',
              ),
            ],
          };
        }

        cancelledBookingCode = bookingCode;
        this.chatGateway.emitBookingCancelled(conversationId, {
          ...cancellationPayload,
          ...result.output,
        });
        return {
          messages: [
            new AIMessage(
              isVietnamese
                ? 'Lịch đặt của bạn đã được hủy.'
                : 'Your booking has been cancelled.',
            ),
          ],
        };
      };

      const bookingSlotSelectedNode = (state: typeof AgentState.State) => {
        const latestUserText = [...state.messages]
          .reverse()
          .find((message) =>
            message.constructor?.name?.includes('HumanMessage'),
          );
        const userText = latestUserText ? messageText(latestUserText) : '';
        const slotSelection = parseBookingSlotSelection(userText);
        const previousAssistantText = [...state.messages]
          .reverse()
          .find((message) => message.constructor?.name?.includes('AIMessage'));
        const isVietnamese =
          slotSelection?.language === 'vi' ||
          (slotSelection?.language !== 'en' &&
            isVietnameseText(
              `${previousAssistantText ? messageText(previousAssistantText) : ''}\n${userText}`,
            ));
        return {
          messages: [
            new AIMessage(
              isVietnamese ? 'Bạn tên là gì?' : "What's your name?",
            ),
          ],
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
        let systemPrompt = this.aiService.buildSystemPrompt({
          messages: [],
          summary: state.summary,
          siteId: state.siteId,
          conversationId: state.conversationId,
          visitorContext: state.visitorContext,
          siteContext: promptSiteContext,
          systemPromptOverride: options.systemPromptOverride,
        });
        if (isSmallTalk) {
          systemPrompt +=
            '\n\nCurrent intent: small talk. Reply briefly to the user message. Do not mention or list booking services, staff, resources, availability, or booking options. Do not output chips or call tools.';
        }

        const messagesWithSystem = [
          new SystemMessage(systemPrompt),
          ...state.messages,
        ];
        const visibleTools = toolsForIntent(state.intent);
        this.logger.log(
          `[Tool Binding] intent=${state.intent ?? 'unknown'} tools=${visibleTools.map((tool) => tool.name).join(', ')}`,
        );
        const shouldStream = !['book_appointment', 'small_talk'].includes(
          state.intent ?? '',
        );
        const boundModel = this.aiService
          .buildModel(0.2, shouldStream, options.maxTokensPerResponse)
          .bindTools(visibleTools);

        const response = await boundModel.invoke(messagesWithSystem, {
          callbacks: [
            {
              handleLLMNewToken(token: string) {
                if (!shouldStream) return;
                if (token) {
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
            const parsed = JSON.parse(lastMessage.content as string) as unknown;

            // Handle booking tools interception
            if (lastMessage.name?.includes('getAvailableSlots')) {
              this.chatGateway.emitBookingSlots(conversationId, parsed);
            } else if (lastMessage.name?.includes('createBooking')) {
              const isActionRequired =
                (parsed as Record<string, unknown>)?.error ===
                'ACTION_REQUIRED';
              if (!isActionRequired) {
                const bookingCode = (parsed as Record<string, unknown>)
                  ?.bookingCode;
                createdBookingCode =
                  typeof bookingCode === 'string' ? bookingCode : undefined;
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
      const SUMMARIZE_THRESHOLD = 10;
      const summarizeMemory = async (state: typeof AgentState.State) => {
        if (state.messages.length <= SUMMARIZE_THRESHOLD) return {};

        this.logger.log(
          `Message threshold (${SUMMARIZE_THRESHOLD}) exceeded. Summarising...`,
        );

        const messagesToSummarize = state.messages.slice(
          0,
          state.messages.length - 2,
        );

        const summaryPrompt = state.summary
          ? `Update the following conversation summary with the new messages. Keep it concise.\n\nCurrent Summary: ${state.summary}\n\nNew Messages:\n${JSON.stringify(messagesToSummarize)}`
          : `Summarise the following conversation concisely:\n${JSON.stringify(messagesToSummarize)}`;

        const response = await this.aiService.invoke({
          messages: [{ role: 'user', content: summaryPrompt }],
        });

        const newSummary = response.content;
        const newCount =
          state.summarizedMessageCount + messagesToSummarize.length;

        // Persist to DB so the next graph run picks up the compressed context
        await this.conversationRepo.update(conversationId, {
          summary: newSummary,
          summarizedMessageCount: newCount,
        });

        return {
          messages: state.messages.slice(state.messages.length - 2),
          summary: newSummary,
          summarizedMessageCount: newCount,
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

      workflow.addConditionalEdges('model_node', toolsCondition, {
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
        knowledgeSources: [],
        summary: existingSummary,
        summarizedMessageCount: existingSummarizedMessageCount,
      });

      // ── 7. Extract last meaningful AI message and persist via onFinish ────────
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
        const textContent =
          typeof lastAiMessage.content === 'string'
            ? lastAiMessage.content
            : (lastAiMessage.content as { type?: string; text?: string }[])
                .filter((c) => c.type === 'text')
                .map((c) => c.text ?? '')
                .join('');

        const latestUserText = messages
          .slice()
          .reverse()
          .find((message) => message.role === 'user')?.content;
        const isVietnamese = isVietnameseText(latestUserText ?? '');
        const intentSafeText =
          finalState.intent === 'small_talk'
            ? sanitizeSmallTalkResponse(
                textContent,
                isVietnamese,
                options.siteContext,
              )
            : sanitizeBookingChips(textContent, options.siteContext);
        const sanitizedText = replacePseudoToolResponse(
          intentSafeText,
          isVietnamese,
        );
        if (sanitizedText.trim()) {
          const bookingMetadata = createdBookingCode
            ? `\n<booking-code>${createdBookingCode}</booking-code>`
            : cancelledBookingCode
              ? `\n<booking-cancelled>${cancelledBookingCode}</booking-cancelled>`
              : '';
          await onFinish(
            `${sanitizedText}${bookingMetadata}`,
            finalState.knowledgeSources,
          );
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
      this.logger.error('LangGraph workflow error', error);

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
