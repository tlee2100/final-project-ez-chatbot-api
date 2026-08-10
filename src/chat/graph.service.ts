import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import { INTENT_CLASSIFIER_SYSTEM_PROMPT } from './prompts';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { AiService } from './ai.service';
import { ChatService } from './chat.service';
import { TOOL_PROVIDER } from './interfaces/tool-provider.interface';
import type {
  IToolProviderFactory,
  IToolProvider,
} from './interfaces/tool-provider.interface';
import type { LLMMessage } from './interfaces/llm-request.interface';
import { Conversation } from './entities/conversation.entity';
import { SenderType } from './entities/chat-message.entity';
import { Site } from '../site/entities/site.entity';
import { ChatGateway } from './chat.gateway';
import { NotificationService } from '../notification/notification.service';
// ─── Agent State ──────────────────────────────────────────────────────────────

/** Intent categories the classifier node can assign */
type IntentType = 'question' | 'request_human' | 'small_talk' | null;

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
  siteContext: Annotation<{ name?: string; domains?: string[] }>({
    reducer: (_, y) => y,
    default: () => ({}),
  }),
  /** Knowledge source references extracted from tool responses */
  knowledgeSources: Annotation<{ documentId: string; filename: string }[]>({
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
  /** Visitor details to provide context to the LLM */
  visitorContext?: {
    name?: string;
    email?: string;
  };
  /** Site details to provide context to the LLM */
  siteContext?: {
    name?: string;
    domains?: string[];
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
    knowledgeSources?: { documentId: string; filename: string }[],
  ) => Promise<void>;
  /** Callback when the graph triggers a human handoff */
  onRequestHandoff: () => Promise<void>;
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
 *
 * Graph topology:
 *   START → classify_intent
 *           ├─ request_human → request_handoff → summarize_memory → END
 *           └─ question/small_talk → model_node
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
    @InjectRepository(Site)
    private readonly siteRepo: Repository<Site>,
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
  ): Promise<void> {
    const aiEnabled = await this.canRunAi(conversationId, siteId);
    if (!aiEnabled) {
      if (res) res.end();
      return;
    }

    const [conversation, site] = await Promise.all([
      this.chatService.getConversationById(conversationId),
      this.siteRepo.findOne({ where: { id: siteId } }),
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
        visitorContext: {
          name: conversation.visitorName ?? undefined,
          email: conversation.visitorEmail ?? undefined,
        },
        siteContext: {
          name: site?.name ?? undefined,
          domains: site?.allowedDomains ?? [],
        },
        existingSummary: conversation.summary ?? undefined,
        existingSummarizedMessageCount: conversation.summarizedMessageCount,
        res,
        server: this.chatGateway.server,
        onFinish,
        onRequestHandoff,
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
              this.logger.log(`[Tool Node] Executing tool: ${def.name}`);
              const result = await currentProvider.execute({
                name: def.name,
                arguments: args,
              });
              return JSON.stringify(result.output);
            },
          }),
      );

      // Separate the human-handoff tool (handled by request_handoff node)
      const aiTools = langchainTools.filter(
        (t) => !t.name.includes('requestHumanAgent'),
      );
      const toolNode = new ToolNode(aiTools);

      // ── 3. Bind tools to the streaming model ────────────────────────────────
      const boundModel = this.aiService
        .buildModel(0.5, true)
        .bindTools(aiTools);

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

        const intentSchema = z.object({
          intent: z
            .enum(['question', 'request_human', 'small_talk'])
            .catch('small_talk'),
        });

        const model = this.aiService
          .buildModel(0, false)
          .withStructuredOutput(intentSchema);

        try {
          const response = await model.invoke([
            new SystemMessage(INTENT_CLASSIFIER_SYSTEM_PROMPT),
            new HumanMessage(`<user_input>\n${contentStr}\n</user_input>`),
          ]);

          this.logger.log(`Intent classified: ${response.intent}`);
          return { intent: response.intent as IntentType };
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

      /**
       * model_node — invokes the bound LLM with tools, streaming tokens to both
       * the HTTP response (visitor) and the WebSocket room (admin dashboard).
       */
      const modelNode = async (state: typeof AgentState.State) => {
        const systemPrompt = this.aiService.buildSystemPrompt({
          messages: [],
          summary: state.summary,
          siteId: state.siteId,
          conversationId: state.conversationId,
          visitorContext: state.visitorContext,
          siteContext: state.siteContext,
        });

        const messagesWithSystem = [
          new SystemMessage(systemPrompt),
          ...state.messages,
        ];

        const response = await boundModel.invoke(messagesWithSystem, {
          callbacks: [
            {
              handleLLMNewToken(token: string) {
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
        if (
          lastMessage instanceof ToolMessage &&
          lastMessage.name?.includes('searchKnowledge')
        ) {
          try {
            const parsed = JSON.parse(lastMessage.content as string) as unknown;

            // Handle both { chunks: [...] } from MCP and [...] from older mocks
            let results: unknown[] = [];
            if (Array.isArray(parsed)) {
              results = parsed;
            } else if (
              parsed &&
              typeof parsed === 'object' &&
              'chunks' in parsed &&
              Array.isArray((parsed as Record<string, unknown>).chunks)
            ) {
              results = (parsed as Record<string, unknown>).chunks as unknown[];
            }

            const sourcesMap = new Map<string, string>();
            results.forEach((c: unknown) => {
              if (c && typeof c === 'object') {
                const chunk = c as Record<string, unknown>;
                if (
                  typeof chunk.documentId === 'string' &&
                  typeof chunk.filename === 'string'
                ) {
                  sourcesMap.set(chunk.documentId, chunk.filename);
                }
              }
            });
            const knowledgeSources = Array.from(sourcesMap.entries()).map(
              ([documentId, filename]) => ({ documentId, filename }),
            );
            return { knowledgeSources };
          } catch (error) {
            this.logger.error('Failed to parse searchKnowledge output', error);
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
        .addNode('request_handoff', requestHandoff)
        .addNode('summarize_memory', summarizeMemory);

      // Edges
      workflow.addEdge(START, 'classify_intent');

      workflow.addConditionalEdges('classify_intent', (state) =>
        state.intent === 'request_human' ? 'request_handoff' : 'model_node',
      );

      workflow.addConditionalEdges('model_node', toolsCondition, {
        tools: 'tools',
        __end__: 'summarize_memory',
      });

      workflow.addEdge('tools', 'parse_tools');
      workflow.addEdge('parse_tools', 'model_node');
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

        if (textContent.trim()) {
          await onFinish(textContent, finalState.knowledgeSources);
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
