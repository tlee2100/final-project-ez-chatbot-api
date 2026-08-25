import { StateGraph, START, END } from '@langchain/langgraph';
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { Response as ExpressResponse } from 'express';
import type { Server as SocketServer } from 'socket.io';
import type { Logger } from '@nestjs/common';
import { AgentState } from '../graph-state';
import type { GraphRunOptions, KnowledgeSearchStatus } from '../graph-state';
import type { AiService } from '../ai.service';
import type { IToolProvider } from '../interfaces/tool-provider.interface';
import type { LLMMessage } from '../interfaces/llm-request.interface';
import {
  getKnowledgeFallbackPrompt,
  getKnowledgeGroundingRule,
} from '../prompts';
import { parseKnowledgeSearchOutput } from '../chat-flow.utils';

export interface KnowledgeSubgraphDeps {
  toolProvider: IToolProvider;
  aiService: AiService;
  logger: Logger;
  conversationId: string;
  siteId: string;
  options: Pick<
    GraphRunOptions,
    'site' | 'maxTokensPerResponse' | 'systemPromptOverride'
  >;
  res?: ExpressResponse;
  server: SocketServer;
  streamedTokensRef?: { count: number };
}

const messageText = (message: BaseMessage): string => {
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

const getLatestUserText = (state: typeof AgentState.State): string => {
  const msg = [...state.messages]
    .reverse()
    .find((m) => m.constructor?.name?.includes('HumanMessage'));
  return msg ? messageText(msg) : '';
};

/**
 * KnowledgeSubgraph — xử lý câu hỏi RAG (intent: 'question').
 * Nodes: search_knowledge → parse_tools → [knowledge_fallback | model_node]
 * Không có interrupt() — chỉ trả lời, không cần user confirm.
 */
export function buildKnowledgeSubgraph(deps: KnowledgeSubgraphDeps) {
  const {
    toolProvider,
    aiService,
    logger,
    conversationId,
    options,
    res,
    server,
    streamedTokensRef,
  } = deps;

  const searchKnowledgeNode = async (state: typeof AgentState.State) => {
    const query = getLatestUserText(state).trim();
    const toolCallId = `knowledge-${state.conversationId}-${state.messages.length}`;
    let output: Record<string, unknown>;

    try {
      const result = await toolProvider.execute({
        name: 'searchKnowledge',
        arguments: { query },
      });
      output = result.output ?? {};
    } catch (error) {
      logger.error('[Knowledge Search] Forced retrieval failed', error);
      output = { error: 'Knowledge retrieval unavailable' };
    }

    return {
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'searchKnowledge',
              args: { query },
              id: toolCallId,
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          content: JSON.stringify(output),
          tool_call_id: toolCallId,
          name: 'searchKnowledge',
        }),
      ],
    };
  };

  const parseToolsNode = (state: typeof AgentState.State) => {
    const recentToolMessages: BaseMessage[] = [];
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (!(message instanceof ToolMessage)) break;
      recentToolMessages.unshift(message as BaseMessage);
    }

    const sourcesMap = new Map<
      string,
      { filename: string; sourceUrl?: string }
    >();
    let knowledgeAttempted = false;
    let knowledgeFailed = false;
    let knowledgeResultCount = 0;

    for (const toolMessage of recentToolMessages) {
      const isKnowledgeSearch = toolMessage.name?.includes('searchKnowledge');
      if (!isKnowledgeSearch) continue;

      try {
        const rawContent =
          typeof toolMessage.content === 'string'
            ? toolMessage.content
            : JSON.stringify(toolMessage.content);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(rawContent);
        } catch {
          parsed = null;
        }

        if (!parsed) continue;

        knowledgeAttempted = true;
        const knowledgeOutput = parseKnowledgeSearchOutput(parsed);
        if (knowledgeOutput.status === 'error') {
          knowledgeFailed = true;
          logger.warn('[Knowledge Search] Tool failed');
          continue;
        }

        const results = knowledgeOutput.chunks;
        knowledgeResultCount += results.length;
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
      } catch (error) {
        logger.error('Failed to parse knowledge search output', error);
        knowledgeAttempted = true;
        knowledgeFailed = true;
      }
    }

    if (knowledgeAttempted) {
      const knowledgeSearchStatus: KnowledgeSearchStatus =
        knowledgeResultCount > 0
          ? 'success'
          : knowledgeFailed
            ? 'error'
            : 'empty';
      const knowledgeSources = Array.from(sourcesMap.entries()).map(
        ([documentId, source]) => ({ documentId, ...source }),
      );
      logger.log(
        `[Knowledge Search] status=${knowledgeSearchStatus} chunks=${knowledgeResultCount} sources=${knowledgeSources.length}`,
      );
      return { knowledgeSearchStatus, knowledgeSources };
    }

    return {};
  };

  const knowledgeFallbackNode = (state: typeof AgentState.State) => ({
    messages: [
      new AIMessage(
        getKnowledgeFallbackPrompt(
          state.locale,
          state.knowledgeSearchStatus === 'error',
        ),
      ),
    ],
  });

  const modelNode = async (state: typeof AgentState.State) => {
    const promptSiteContext = state.siteContext;
    const convertedMessages: LLMMessage[] = state.messages.map((m) => ({
      role: m.constructor?.name?.includes('HumanMessage')
        ? ('user' as const)
        : ('assistant' as const),
      content: messageText(m),
    }));

    let systemPrompt = aiService.buildSystemPrompt({
      messages: convertedMessages,
      summary: state.summary,
      siteId: state.siteId,
      conversationId: state.conversationId,
      visitorContext: state.visitorContext,
      siteContext: promptSiteContext,
      systemPromptOverride: options.systemPromptOverride,
      locale: state.locale,
    });

    if (
      state.knowledgeSearchStatus === 'success' ||
      state.knowledgeSearchStatus === 'empty'
    ) {
      systemPrompt += `\n\n${getKnowledgeGroundingRule(state.knowledgeSearchStatus)}`;
    }

    const messagesWithSystem = [
      new SystemMessage(systemPrompt),
      ...state.messages,
    ];

    const model = aiService.buildModelForSite(
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
              if (streamedTokensRef) {
                streamedTokensRef.count++;
              }
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

  const workflow = new StateGraph(AgentState)
    .addNode('search_knowledge', searchKnowledgeNode)
    .addNode('parse_tools', parseToolsNode)
    .addNode('knowledge_fallback', knowledgeFallbackNode)
    .addNode('model_node', modelNode)
    .addEdge(START, 'search_knowledge')
    .addEdge('search_knowledge', 'parse_tools')
    .addConditionalEdges(
      'parse_tools',
      (state) =>
        state.intent === 'question' && state.knowledgeSearchStatus === 'error'
          ? 'knowledge_fallback'
          : 'model_node',
      { knowledge_fallback: 'knowledge_fallback', model_node: 'model_node' },
    )
    .addEdge('knowledge_fallback', END)
    .addEdge('model_node', END);

  return workflow.compile();
}
