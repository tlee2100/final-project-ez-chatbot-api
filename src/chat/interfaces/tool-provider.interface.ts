/**
 * Describes a tool available to the LangGraph agent.
 */
export interface ToolDefinition {
  /** Unique tool name used to route tool calls from the model */
  name: string;
  /** Human-readable description shown to the LLM in its system context */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  schema: Record<string, unknown>;
}

/**
 * A request from the LangGraph agent to execute a specific tool.
 */
export interface ToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The result returned by a tool execution.
 */
export interface ToolResult {
  output: Record<string, unknown>;
}

/**
 * Contract for any tool provider wired into the LangGraph agent.
 *
 * Replaced MockToolProvider with McpToolProviderFactory.
 */
export interface IToolProvider {
  listTools(): Promise<ToolDefinition[]>;
  execute(request: ToolRequest): Promise<ToolResult>;
  disconnect?(): Promise<void>;
}

export interface ToolContext {
  siteId: string;
  conversationId: string;
}

export interface IToolProviderFactory {
  create(context: ToolContext): Promise<IToolProvider>;
}

/** NestJS injection token for IToolProviderFactory */
export const TOOL_PROVIDER = 'TOOL_PROVIDER';
