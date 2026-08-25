import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import {
  StateGraph,
  START,
  END,
  MemorySaver,
  Command,
} from '@langchain/langgraph';
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Response as ExpressResponse } from 'express';
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
  AgentState,
  type IntentType,
  type GraphRunOptions,
  type GraphRunResult,
  type CancelFlowAction,
  type CancelStep,
  type CancelState,
  type KnowledgeSearchStatus,
} from './graph-state';
import { buildIntentClassifierNode } from './intent-classifier.node';
import { buildKnowledgeSubgraph } from './subgraphs/knowledge.subgraph';
import { buildBookingSubgraph } from './subgraphs/booking.subgraph';
import { buildCancellationSubgraph } from './subgraphs/cancellation.subgraph';
import {
  getAbandonBookingPrompt,
  getOutOfScopePrompt,
  getPublicCapabilitiesPrompt,
} from './prompts';
import { latestActiveBookingCode } from './booking-cancellation.utils';
import {
  bookingCodeText,
  enforceBookingChipScope,
  extractRequestedTimeSlot,
  isBookingFlowIntent,
  isBookingSlotSelection,
  isTimeSlotAvailable,
  parseBookingSlotSelection,
  parseMultimodalContent,
  stripReasoningContent,
} from './chat-flow.utils';
import { AdminTestStreamDto } from './dto/admin-test-stream.dto';
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveEffectiveLocale,
  UNDETERMINED_LOCALE,
} from './chat-locale.utils';
import {
  buildChatMessageComponents,
  stripModelBookingDirectives,
  type ChatMessageComponent,
} from './chat-message-components';
import { buildToolSchema } from './tool-schema.utils';

export { AgentState };
export type {
  IntentType,
  GraphRunOptions,
  GraphRunResult,
  CancelFlowAction,
  CancelStep,
  CancelState,
  KnowledgeSearchStatus,
};

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * GraphService — LangGraph orchestration & coordinator layer.
 *
 * Responsibilities:
 *  - Coordinate intent classification and domain subgraphs (Knowledge, Booking, Cancellation).
 *  - Manage interrupt() checkpoints via LangGraph MemorySaver for human-in-the-loop flows.
 *  - Guard: check site.isAiActive && conversation.isAiActive before running.
 *  - Fan out LLM tokens to both HTTP SSE (res.write) and WebSocket (server.emit).
 *  - Persist updated summary and summarizedMessageCount to the database.
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private readonly testSessionMessages = new Map<string, LLMMessage[]>();

  /**
   * LangGraph MemorySaver — preserves graph interrupt states per conversation thread.
   */
  private readonly checkpointer = new MemorySaver();

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
      this.siteRepo.findOne({
        where: { id: siteId },
        relations: {
          industryTemplateInfo: true,
          bookingConfig: true,
          bookingServices: true,
          bookingResources: true,
        },
      }),
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
      await this.runStream({
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
    } finally {
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('ai-stream-end', { conversationId });
    }
  }

  // ─── Admin In-Dashboard Testing (Stateless SSE) ──────────────────────────────

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
        onFinish: async () => {},
        onRequestHandoff: async () => {},
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

  // ─── Low-level graph runner (Coordinator) ──────────────────────────────────

  /**
   * Runs the LangGraph coordinator workflow for a single visitor message.
   * Compiles with checkpointer to support interrupt() and Command({ resume }).
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
    const streamedTokensRef = { count: 0 };
    const latestUserText =
      messages
        .slice()
        .reverse()
        .find((message) => message.role === 'user')?.content ?? '';
    const requestedTimeSlot = extractRequestedTimeSlot(latestUserText);
    const selectedFromWidget = isBookingSlotSelection(latestUserText);
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

                const normalizeStr = (str: string) =>
                  str
                    .toLowerCase()
                    .normalize('NFD')
                    .replace(/[\u0300-\u036f]/g, '')
                    .replace(/đ/g, 'd')
                    .trim();

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
                  const itemNorm = normalizeStr(item.name);
                  return userMessages.some((msg) =>
                    normalizeStr(msg).includes(itemNorm),
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

      // ── 3. Build Subgraphs ───────────────────────────────────────────────────
      const knowledgeSubgraph = buildKnowledgeSubgraph({
        toolProvider: currentProvider,
        aiService: this.aiService,
        logger: this.logger,
        conversationId,
        siteId,
        options,
        res,
        server,
        streamedTokensRef,
      });

      const bookingSubgraph = buildBookingSubgraph({
        toolProvider: currentProvider,
        aiService: this.aiService,
        logger: this.logger,
        conversationId,
        siteId,
        options,
        chatGateway: this.chatGateway,
        res,
        server,
        streamedTokensRef,
        bookingTools: aiTools,
        clearActiveFlow,
        onCreatedBookingCode: (code) => {
          createdBookingCode = code;
        },
      });

      const cancellationSubgraph = buildCancellationSubgraph({
        toolProvider: currentProvider,
        bookingService: this.bookingService,
        logger: this.logger,
        conversationId,
        siteId,
        chatGateway: this.chatGateway,
        res,
        server,
        clearActiveFlow,
        activeConversationBookingCode,
        onCancelledBookingCode: (code) => {
          cancelledBookingCode = code;
        },
      });

      // ── 4. Coordinator Node Implementations ──────────────────────────────────
      const classifyIntent = buildIntentClassifierNode({
        aiService: this.aiService,
        logger: this.logger,
        options,
        applyLocaleState,
        getActiveFlow: () => activeFlow,
        getActiveFlowLocale: () => activeFlowLocale,
        getCurrentLocale: () => currentLocale,
        onNegativeSentimentDetected: async () => {
          if (options.onNegativeSentiment) {
            await options.onNegativeSentiment(latestUserText);
            await this.conversationRepo.update(conversationId, {
              hasNegativeSentiment: true,
            });
          }
        },
      });

      const smallTalkNode = async (state: typeof AgentState.State) => {
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
          siteContext: {
            name: state.siteContext.name,
            domains: state.siteContext.domains,
          },
          systemPromptOverride: options.systemPromptOverride,
          locale: state.locale,
        });

        systemPrompt +=
          '\n\nCurrent intent: small talk. Reply briefly to the user message. Do not mention or list booking services, staff, resources, availability, or booking options. Do not output chips or call tools.';

        const messagesWithSystem = [
          new SystemMessage(systemPrompt),
          ...state.messages,
        ];

        const model = this.aiService.buildModelForSite(
          options.site ?? {},
          0.2,
          true,
          options.maxTokensPerResponse,
        );

        const response = await model.invoke(messagesWithSystem, {
          callbacks: [
            {
              handleLLMNewToken(token: string) {
                if (token) {
                  streamedTokensRef.count++;
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

        return { messages: [response] };
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

      const requestHandoff = async () => {
        if (!options.siteContext?.humanHandoffEnabled) {
          const noHandoffMsg =
            'Live agent support is currently unavailable. I am an AI assistant and will continue to help you with your inquiries.';
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

      const abandonBookingNode = (state: typeof AgentState.State) => ({
        exitSubgraph: null,
        messages: [new AIMessage(getAbandonBookingPrompt(state.locale))],
      });

      const SUMMARIZE_THRESHOLD = 25;
      const summarizeMemory = (state: typeof AgentState.State) => {
        if (state.messages.length <= SUMMARIZE_THRESHOLD) return {};

        const messagesToSummarize = state.messages.slice(
          0,
          state.messages.length - 2,
        );

        const formattedMessages = messagesToSummarize
          .map((m) => {
            const role = m.constructor?.name?.includes('HumanMessage')
              ? 'User'
              : 'Assistant';
            return `${role}: ${messageText(m)}`;
          })
          .join('\n');

        const summaryPrompt = state.summary
          ? `Update the following conversation summary with the new messages. Keep it concise.\n\nCurrent Summary: ${state.summary}\n\nNew Messages:\n${formattedMessages}`
          : `Summarise the following conversation concisely:\n${formattedMessages}`;

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

      // ── 5. Build Coordinator Workflow ────────────────────────────────────────
      const mainWorkflow = new StateGraph(AgentState)
        .addNode('classify_intent', classifyIntent)
        .addNode('knowledge_agent', knowledgeSubgraph)
        .addNode('booking_agent', bookingSubgraph)
        .addNode('cancel_agent', cancellationSubgraph)
        .addNode('small_talk', smallTalkNode)
        .addNode('system_question', systemQuestionNode)
        .addNode('out_of_scope', outOfScopeNode)
        .addNode('abandon_booking', abandonBookingNode)
        .addNode('request_handoff', requestHandoff)
        .addNode('summarize_memory', summarizeMemory)
        .addEdge(START, 'classify_intent')
        .addConditionalEdges(
          'classify_intent',
          (state) => state.intent ?? 'small_talk',
          {
            question: 'knowledge_agent',
            book_appointment: 'booking_agent',
            book_appointment_init: 'booking_agent',
            structured_booking_step: 'booking_agent',
            booking_slot_selected: 'booking_agent',
            confirm_booking: 'booking_agent',
            check_booking: 'booking_agent',
            cancel_booking: 'cancel_agent',
            abort_cancel_flow: 'cancel_agent',
            small_talk: 'small_talk',
            system_question: 'system_question',
            out_of_scope: 'out_of_scope',
            request_human: 'request_handoff',
            abandon_booking: 'abandon_booking',
          },
        )
        .addConditionalEdges(
          'booking_agent',
          (state) =>
            state.exitSubgraph === 'abandon'
              ? 'abandon_booking'
              : 'summarize_memory',
          {
            abandon_booking: 'abandon_booking',
            summarize_memory: 'summarize_memory',
          },
        )
        .addConditionalEdges(
          'cancel_agent',
          (state) =>
            state.exitSubgraph === 'switch_topic'
              ? 'classify_intent'
              : 'summarize_memory',
          {
            classify_intent: 'classify_intent',
            summarize_memory: 'summarize_memory',
          },
        )
        .addEdge('knowledge_agent', 'summarize_memory')
        .addEdge('small_talk', 'summarize_memory')
        .addEdge('system_question', 'summarize_memory')
        .addEdge('out_of_scope', 'summarize_memory')
        .addEdge('abandon_booking', 'summarize_memory')
        .addEdge('request_handoff', 'summarize_memory')
        .addEdge('summarize_memory', END);

      const isTestSession = conversationId.startsWith('admin-test-');
      const app = isTestSession
        ? mainWorkflow.compile()
        : mainWorkflow.compile({ checkpointer: this.checkpointer });

      const threadConfig = {
        configurable: { thread_id: conversationId },
      };

      // ── 6. Resume-Aware Invocation ──────────────────────────────────────────
      let finalState: typeof AgentState.State;

      if (!isTestSession) {
        const currentState = await app.getState(threadConfig).catch(() => null);
        const hasPendingInterrupt = Boolean(
          currentState &&
          currentState.tasks?.some(
            (task: { interrupts?: unknown[] }) =>
              Array.isArray(task.interrupts) && task.interrupts.length > 0,
          ),
        );

        if (hasPendingInterrupt) {
          this.logger.log({
            event: 'graph_resume_interrupt',
            conversationId,
            messagePrefix: latestUserText.slice(0, 50),
          });

          finalState = await app.invoke(
            new Command({ resume: latestUserText }),
            threadConfig,
          );
        } else {
          finalState = await app.invoke(
            {
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
              cancelState: options.initialCancelState ??
                (currentState?.values as typeof AgentState.State | undefined)
                  ?.cancelState ?? {
                  step: null,
                  bookingCode: null,
                  phoneVerified: false,
                },
              knowledgeSources: [],
              knowledgeSearchStatus: 'idle',
              summary: existingSummary,
              summarizedMessageCount: existingSummarizedMessageCount,
              exitSubgraph: null,
            },
            threadConfig,
          );
        }
      } else {
        finalState = await app.invoke({
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
          exitSubgraph: null,
        });
      }

      // ── 7. Extract last meaningful AI message and persist via onFinish ────────
      this.logger.log({
        event: 'graph_run_completed',
        conversationId,
        siteId,
        intent: finalState.intent,
        locale: finalState.locale,
        messageCount: finalState.messages.length,
        knowledgeStatus: finalState.knowledgeSearchStatus,
      });

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

        const detectedLang = finalState.locale;
        const bookingChipsAllowed = isBookingFlowIntent(finalState.intent);
        const modelText = enforceBookingChipScope(
          stripReasoningContent(textContent).replace(
            /\s*\[cancel:[^\]]+\]/g,
            '',
          ),
          finalState.intent,
        );
        const fallbackStep =
          finalState.intent === 'book_appointment_init' ? 'service' : null;
        const components = bookingChipsAllowed
          ? buildChatMessageComponents(
              modelText,
              options.siteContext,
              options.visitorContext,
              new Date(),
              latestUserText,
              fallbackStep,
            )
          : undefined;

        let codeAppended = false;
        let decoratedText = stripModelBookingDirectives(modelText);
        if (
          createdBookingCode &&
          !decoratedText.includes(createdBookingCode) &&
          !decoratedText.includes('<booking-code>')
        ) {
          decoratedText = `${decoratedText.trimEnd()}\n\n${bookingCodeText(createdBookingCode)}`;
          codeAppended = true;
        }

        if (
          cancelledBookingCode &&
          !decoratedText.includes('<booking-cancelled>')
        ) {
          decoratedText = `${decoratedText.trimEnd()}\n\n<booking-cancelled>${cancelledBookingCode}</booking-cancelled>`;
        }

        if (codeAppended && createdBookingCode) {
          if (res) {
            res.write(`\n\n${bookingCodeText(createdBookingCode)}`);
          }
          server.to(`conversation-${conversationId}`).emit('aiChunk', {
            token: `\n\n${bookingCodeText(createdBookingCode)}`,
            conversationId,
          });
        }

        await onFinish(
          decoratedText,
          finalState.knowledgeSources,
          detectedLang,
          components,
        );
      }

      if (res && !res.writableEnded) {
        res.end();
      }

      return {
        newSummary: finalState.summary,
        newSummarizedMessageCount: finalState.summarizedMessageCount,
      };
    } finally {
      if (toolProvider?.disconnect) {
        await toolProvider.disconnect();
      }
    }
  }
}
