import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  IToolProviderFactory,
  ToolContext,
  IToolProvider,
  ToolDefinition,
} from '../interfaces/tool-provider.interface';
import { McpToolProvider } from './mcp-tool-provider';

@Injectable()
export class McpToolProviderFactory implements IToolProviderFactory {
  private readonly logger = new Logger(McpToolProviderFactory.name);
  private cachedTools: ToolDefinition[] | null = null;
  private readonly mcpServerUrl: string;

  constructor(private readonly jwtService: JwtService) {
    this.mcpServerUrl =
      process.env.MCP_SERVER_URL || 'http://localhost:3002/mcp';
  }

  private async fetchToolSchemas(
    context: ToolContext,
  ): Promise<ToolDefinition[]> {
    this.logger.log(
      `Fetching MCP tool schemas lazily from ${this.mcpServerUrl}...`,
    );
    const token = this.jwtService.sign(
      {
        sub: 1,
        siteId: context.siteId,
        conversationId: context.conversationId,
      },
      { expiresIn: '1h' },
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(this.mcpServerUrl),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-MCP-Secret': process.env.MCP_INTERNAL_SECRET || '',
          },
        },
      },
    );

    const client = new Client(
      { name: 'chatbot-api-init', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);

    const response = await client.listTools();
    const tools = response.tools.map((t) => ({
      name: t.name,
      description: t.description || '',
      schema: t.inputSchema,
    }));

    await transport.close();
    return tools;
  }

  async create(context: ToolContext): Promise<IToolProvider> {
    if (!this.cachedTools) {
      this.cachedTools = await this.fetchToolSchemas(context);
      this.logger.log(`Cached ${this.cachedTools.length} MCP tools.`);
    }

    const token = this.jwtService.sign(
      {
        sub: 1,
        siteId: context.siteId,
        conversationId: context.conversationId,
      },
      { expiresIn: '1h' },
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(this.mcpServerUrl),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-MCP-Secret': process.env.MCP_INTERNAL_SECRET || '',
          },
        },
      },
    );

    const client = new Client(
      { name: 'chatbot-api-session', version: '1.0.0' },
      { capabilities: {} },
    );

    return new McpToolProvider(client, transport, this.cachedTools);
  }
}
