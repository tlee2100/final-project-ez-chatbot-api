import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolDefinition } from '../interfaces/tool-provider.interface';
import { McpToolProvider } from './mcp-tool-provider';

const tools: ToolDefinition[] = [
  {
    name: 'searchKnowledge',
    description: 'Search knowledge',
    schema: {},
  },
];

const createProvider = () => {
  const connect = jest.fn().mockResolvedValue(undefined);
  const callTool = jest.fn().mockResolvedValue({
    content: [{ type: 'text', text: '{"answer":"ok"}' }],
  });
  const close = jest.fn().mockResolvedValue(undefined);
  const client = {
    connect,
    callTool,
  } as unknown as Client;
  const transport = {
    close,
  } as unknown as StreamableHTTPClientTransport;

  return {
    connect,
    callTool,
    close,
    provider: new McpToolProvider(client, transport, tools),
  };
};

describe('McpToolProvider', () => {
  it('does not connect when a turn only needs cached tool schemas', async () => {
    const { connect, close, provider } = createProvider();

    await expect(provider.listTools()).resolves.toEqual(tools);
    await provider.disconnect();

    expect(connect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('connects once on first execution and closes the active transport', async () => {
    const { connect, callTool, close, provider } = createProvider();
    const request = { name: 'searchKnowledge', arguments: { query: 'hours' } };

    await expect(provider.execute(request)).resolves.toEqual({
      output: { answer: 'ok' },
    });
    await provider.execute(request);
    await provider.disconnect();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('returns connection failures as tool errors and allows a later retry', async () => {
    const { connect, callTool, provider } = createProvider();
    const request = { name: 'searchKnowledge', arguments: { query: 'hours' } };
    connect.mockRejectedValueOnce(new Error('MCP unavailable'));

    await expect(provider.execute(request)).resolves.toEqual({
      output: { error: 'Error: MCP unavailable' },
    });
    await expect(provider.execute(request)).resolves.toEqual({
      output: { answer: 'ok' },
    });

    expect(connect).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('preserves MCP error results for fail-closed graph handling', async () => {
    const { callTool, provider } = createProvider();
    callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'Knowledge service unavailable' }],
    });

    await expect(
      provider.execute({
        name: 'searchKnowledge',
        arguments: { query: 'hours' },
      }),
    ).resolves.toEqual({
      output: { error: 'Knowledge service unavailable' },
    });
  });
});
