import { Annotation } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { CancelFlowAction, CancelState, CancelStep } from './prompts';
import type { KnowledgeSearchStatus } from './chat-flow.utils';
import type { LLMMessage } from './interfaces/llm-request.interface';
import type { SanitizedPageContext } from './interfaces/page-context.interface';
import type { ChatMessageComponent } from './chat-message-components';
import { DEFAULT_LOCALE } from './chat-locale.utils';

/** Intent categories the classifier node can assign */
export type IntentType =
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
export const AgentState = Annotation.Root({
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
  pageContext: Annotation<SanitizedPageContext | undefined>({
    reducer: (_, y) => y,
    default: () => undefined,
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
    reducer: (x, y) => {
      if (!y) return x;
      if (y.step === null && x?.step !== null && x?.step !== undefined) {
        return x;
      }
      return y;
    },
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
  /**
   * Signal từ subgraph về parent coordinator khi user muốn thoát flow.
   * 'abandon' → routing đến abandon_booking node
   * 'switch_topic' → routing đến classify_intent (re-classify)
   * null → kết thúc bình thường
   */
  exitSubgraph: Annotation<'abandon' | 'switch_topic' | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
});

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
  /** Sanitized page content for the current visitor message. */
  pageContext?: SanitizedPageContext;
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

export type {
  CancelFlowAction,
  CancelStep,
  CancelState,
  KnowledgeSearchStatus,
};
