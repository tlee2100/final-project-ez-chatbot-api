/**
 * Represents a single message in the conversation history sent to the LLM.
 */
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Input contract for the AiService.
 * Consumed by both invoke() and stream() methods.
 */
export interface LLMRequest {
  /** Full conversation history (user/assistant turns) */
  messages: LLMMessage[];

  /** Optional system prompt override. Defaults to SYSTEM_PROMPT env var. */
  systemPrompt?: string;

  /** Site UUID — used to scope tool calls and knowledge retrieval */
  siteId?: string;

  /** Conversation UUID — passed to tools for context */
  conversationId?: string;

  /** Optional summary of earlier messages to compress history */
  summary?: string;

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
}
