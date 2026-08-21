import { Logger } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  IToolProvider,
  ToolDefinition,
  ToolRequest,
  ToolResult,
} from '../interfaces/tool-provider.interface';

export class McpToolProvider implements IToolProvider {
  private readonly logger = new Logger(McpToolProvider.name);
  private connectPromise?: Promise<void>;

  constructor(
    private readonly client: Client,
    private readonly transport: StreamableHTTPClientTransport,
    private readonly cachedTools: ToolDefinition[],
  ) {}

  listTools(): Promise<ToolDefinition[]> {
    return Promise.resolve(this.cachedTools);
  }

  private ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.client
        .connect(this.transport)
        .catch((error) => {
          this.connectPromise = undefined;
          throw error;
        });
    }

    return this.connectPromise;
  }

  async execute(request: ToolRequest): Promise<ToolResult> {
    this.logger.log(`[MCP Tool] Executing tool: ${request.name}`);

    try {
      await this.ensureConnected();
      const result = await this.client.callTool({
        name: request.name,
        arguments: request.arguments,
      });

      if (result.isError) {
        const message = Array.isArray(result.content)
          ? result.content
              .map((item: unknown) => {
                if (!item || typeof item !== 'object' || !('text' in item)) {
                  return '';
                }
                const text = (item as Record<string, unknown>).text;
                return typeof text === 'string' ? text : '';
              })
              .filter(Boolean)
              .join(' ')
          : '';
        return { output: { error: message || 'MCP tool execution failed' } };
      }

      // The result.content is usually an array of objects e.g. [{ type: 'text', text: '...' }]
      // If it's a single text item that's JSON stringified, we can parse it for LangChain or just return raw.
      // We'll return the raw content, and the graph parser can deal with it or we stringify it.
      // Usually, callTool returns { content: [...] }

      let finalOutput: unknown = result.content;
      const contentArray = result.content as unknown[];
      if (
        Array.isArray(contentArray) &&
        contentArray.length > 0 &&
        typeof contentArray[0] === 'object' &&
        contentArray[0] !== null &&
        'type' in contentArray[0] &&
        (contentArray[0] as Record<string, unknown>).type === 'text'
      ) {
        const textOutput = (contentArray[0] as Record<string, unknown>).text;
        if (typeof textOutput === 'string') {
          try {
            finalOutput = JSON.parse(textOutput);
          } catch {
            finalOutput = textOutput;
          }
        }
      }

      return {
        output:
          typeof finalOutput === 'object' &&
          finalOutput !== null &&
          !Array.isArray(finalOutput)
            ? (finalOutput as Record<string, unknown>)
            : { result: finalOutput },
      };
    } catch (error) {
      this.logger.error(`[MCP Tool] Failed to execute ${request.name}`, error);
      return { output: { error: String(error) } };
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connectPromise) return;

    try {
      await this.connectPromise;
      await this.transport.close();
    } catch (error) {
      this.logger.error('[MCP Tool] Error closing transport', error);
    }
  }
}
