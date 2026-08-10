import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import OpenAI from 'openai';
import type { ChatMessage } from '../chat/entities/chat-message.entity';
import { SenderType } from '../chat/entities/chat-message.entity';

@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);
  private openai: OpenAI;
  private mcpServerUrl: string;
  private mcpSecret: string;

  constructor(private readonly jwtService: JwtService) {
    this.mcpServerUrl = process.env.MCP_SERVER_URL || 'http://localhost:4000';
    this.mcpSecret = process.env.MCP_INTERNAL_SECRET || '';

    if (!process.env.DEEPSEEK_API_KEY) {
      this.logger.warn('DEEPSEEK_API_KEY is missing. AI replies will fail.');
    }

    this.openai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY || 'mock-key',
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    });
  }

  /**
   * Signs the tenant context into a JWT token that acts as the X-MCP-Context header.
   */
  private signMcpContext(siteId: string, conversationId: string): string {
    return this.jwtService.sign(
      { sub: 0, siteId, conversationId, type: 'service' },
      { expiresIn: (process.env.MCP_SESSION_JWT_EXPIRES_IN || '5m') as '5m' },
    );
  }

  /**
   * Generates a reply using the LLM and the per-session MCP client.
   * Follows the MCP-009 PRD specification for the raw tool-calling loop.
   */
  async generateReply(
    siteId: string,
    conversationId: string,
    history: ChatMessage[],
    newMessageContent: string,
  ): Promise<string> {
    const signedContext = this.signMcpContext(siteId, conversationId);

    // 1. Create per-session MCP Client
    const transport = new StreamableHTTPClientTransport(
      new URL(`${this.mcpServerUrl}/mcp`),
      {
        requestInit: {
          headers: {
            'X-MCP-Secret': this.mcpSecret,
            'X-MCP-Context': signedContext,
          },
        },
      },
    );

    const mcpClient = new Client(
      { name: 'ez-chat-agent', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      this.logger.log(
        `Connecting MCP client for conversation ${conversationId}`,
      );
      await mcpClient.connect(transport);

      // 2. Discover Tools
      const { tools } = await mcpClient.listTools();
      const openaiTools = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));

      // 3. Build Messages Array
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
          role: 'system' as const,
          content:
            'You are a helpful customer support assistant. You have access to tools to search the knowledge base and manage bookings. Always use tools to answer questions about the business.',
        },
        ...history.map((m): OpenAI.Chat.ChatCompletionMessageParam => ({
          role:
            m.senderType === SenderType.VISITOR
              ? ('user' as const)
              : ('assistant' as const),
          content: m.content,
        })),
        { role: 'user' as const, content: newMessageContent },
      ];

      // 4. Tool Execution Loop
      const model = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
      let loopCount = 0;
      const MAX_LOOPS = 5;

      while (loopCount < MAX_LOOPS) {
        loopCount++;

        this.logger.log(`Calling LLM (Loop ${loopCount})`);
        const response = await this.openai.chat.completions.create({
          model,
          messages,
          tools: openaiTools.length > 0 ? openaiTools : undefined,
        });

        const choice = response.choices[0];
        const message = choice.message;

        // Append LLM's message (which may contain tool calls) to history
        messages.push(message);

        if (choice.finish_reason === 'tool_calls' && message.tool_calls) {
          // Execute all tools concurrently
          const toolResults = await Promise.all(
            message.tool_calls.map(async (toolCall) => {
              if (toolCall.type !== 'function') {
                return {
                  role: 'tool' as const,
                  tool_call_id: toolCall.id,
                  content: 'Unsupported tool type',
                };
              }
              this.logger.log(`Executing tool: ${toolCall.function.name}`);
              let toolResultContent = '';
              try {
                const args = JSON.parse(toolCall.function.arguments) as Record<
                  string,
                  unknown
                >;
                const result = await mcpClient.callTool({
                  name: String(toolCall.function.name),
                  arguments: args,
                });

                const resultArr = result.content as {
                  type: string;
                  text?: string;
                }[];
                toolResultContent =
                  resultArr
                    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
                    .join('\n') || 'Success';
              } catch (err) {
                const errorMsg =
                  err instanceof Error ? err.message : String(err);
                this.logger.error(
                  `Tool ${toolCall.function.name} failed: ${errorMsg}`,
                );
                toolResultContent = `Error: ${errorMsg}`;
              }

              return {
                role: 'tool' as const,
                tool_call_id: toolCall.id,
                content: toolResultContent,
              };
            }),
          );

          // Append tool results to history
          messages.push(...toolResults);
          // Loop continues back to the LLM with the tool results
        } else {
          // Finished
          return message.content || 'I have nothing more to say.';
        }
      }

      return 'I needed to use too many tools and had to stop. Please ask a simpler question.';
    } finally {
      this.logger.log(`Closing MCP client for conversation ${conversationId}`);
      try {
        await mcpClient.close();
      } catch (err) {
        this.logger.error(`Error closing MCP client: ${String(err)}`);
      }
    }
  }
}
