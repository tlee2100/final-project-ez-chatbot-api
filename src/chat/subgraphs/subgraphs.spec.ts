import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { buildKnowledgeSubgraph } from './knowledge.subgraph';
import { buildBookingSubgraph } from './booking.subgraph';
import { buildCancellationSubgraph } from './cancellation.subgraph';
import type { IToolProvider } from '../interfaces/tool-provider.interface';
import type { AiService } from '../ai.service';
import type { BookingService } from '../../booking/booking.service';
import type { ChatGateway } from '../chat.gateway';
import type { Logger } from '@nestjs/common';
import type { Server as SocketServer } from 'socket.io';

// AutoMap mocks for tests
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));
jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
  AutomapperProfile: class {},
}));

describe('LangGraph Subgraphs & Interrupts', () => {
  describe('Knowledge Subgraph', () => {
    it('returns knowledge fallback message when retrieval fails', async () => {
      const executeMock = jest.fn().mockRejectedValue(new Error('KB Offline'));
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: executeMock,
      };

      const mockAiService = {
        buildSystemPrompt: jest.fn().mockReturnValue('System Prompt'),
        buildModelForSite: jest.fn(),
      } as unknown as AiService;

      const mockLogger = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;

      const mockServer = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as unknown as SocketServer;

      const subgraph = buildKnowledgeSubgraph({
        toolProvider: mockToolProvider,
        aiService: mockAiService,
        logger: mockLogger,
        conversationId: 'test-conv-kb',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          maxTokensPerResponse: 500,
        },
        server: mockServer,
      });

      const result = await subgraph.invoke({
        messages: [new HumanMessage('What are your services?')],
        siteId: 'site-1',
        conversationId: 'test-conv-kb',
        visitorContext: {},
        siteContext: {
          domains: [],
          bookingEnabled: false,
          bookingServices: [],
          bookingResources: [],
        },
        intent: 'question',
        locale: 'en',
        activeFlow: null,
        activeFlowLocale: null,
        cancelState: { step: null, bookingCode: null, phoneVerified: false },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: '',
        summarizedMessageCount: 0,
        exitSubgraph: null,
      });

      expect(executeMock).toHaveBeenCalledWith({
        name: 'searchKnowledge',
        arguments: { query: 'What are your services?' },
      });
      expect(result.knowledgeSearchStatus).toBe('error');
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg).toBeInstanceOf(AIMessage);
      expect(typeof lastMsg.content).toBe('string');
    });

    it('forwards the current page context to the knowledge prompt', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn().mockResolvedValue({ output: { chunks: [] } }),
      };
      const invokeMock = jest
        .fn()
        .mockResolvedValue(new AIMessage('Page-grounded response'));
      const buildSystemPromptMock = jest.fn().mockReturnValue('System Prompt');
      const mockAiService = {
        buildSystemPrompt: buildSystemPromptMock,
        buildModelForSite: jest.fn().mockReturnValue({ invoke: invokeMock }),
      } as unknown as AiService;
      const mockLogger = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;
      const mockServer = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as unknown as SocketServer;
      const pageContext = {
        pageUrl: 'https://example.com/products/alpha',
        pageTitle: 'Alpha',
        pageContent: 'Price: $10.',
      };

      const subgraph = buildKnowledgeSubgraph({
        toolProvider: mockToolProvider,
        aiService: mockAiService,
        logger: mockLogger,
        conversationId: 'test-conv-page',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          maxTokensPerResponse: 500,
        },
        server: mockServer,
      });

      await subgraph.invoke({
        messages: [new HumanMessage('What is the price on this page?')],
        siteId: 'site-1',
        conversationId: 'test-conv-page',
        visitorContext: {},
        pageContext,
        siteContext: {
          domains: ['example.com'],
          bookingEnabled: false,
          bookingServices: [],
          bookingResources: [],
        },
        intent: 'question',
        locale: 'en',
        activeFlow: null,
        activeFlowLocale: null,
        cancelState: { step: null, bookingCode: null, phoneVerified: false },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: '',
        summarizedMessageCount: 0,
        exitSubgraph: null,
      });

      expect(buildSystemPromptMock).toHaveBeenCalledWith(
        expect.objectContaining({ pageContext }),
      );
    });
  });

  describe('Booking Subgraph with interrupt()', () => {
    it('generates initial service prompt on book_appointment_init', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn(),
      };

      const mockAiService = {
        buildSystemPrompt: jest.fn(),
        buildModelForSite: jest.fn(),
      } as unknown as AiService;

      const mockChatGateway = {
        emitBookingSummary: jest.fn(),
        emitBookingSuccess: jest.fn(),
        emitBookingSlots: jest.fn(),
      } as unknown as ChatGateway;

      const mockLogger = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;

      const mockServer = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as unknown as SocketServer;

      const subgraph = buildBookingSubgraph({
        toolProvider: mockToolProvider,
        aiService: mockAiService,
        logger: mockLogger,
        conversationId: 'test-conv-book',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          siteContext: {
            bookingEnabled: true,
            bookingServices: [{ id: 's1', name: 'Service 1' }],
            bookingResources: [{ id: 'r1', name: 'Staff 1' }],
          },
          visitorContext: {},
        },
        chatGateway: mockChatGateway,
        server: mockServer,
        bookingTools: [],
        clearActiveFlow: jest.fn().mockResolvedValue(undefined),
      });

      const result = await subgraph.invoke({
        messages: [new HumanMessage('Tôi muốn đặt lịch')],
        siteId: 'site-1',
        conversationId: 'test-conv-book',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          bookingServices: [{ id: 's1', name: 'Service 1' }],
          bookingResources: [{ id: 'r1', name: 'Staff 1' }],
          domains: [],
        },
        intent: 'book_appointment_init',
        locale: 'vi',
        activeFlow: 'BOOKING',
        activeFlowLocale: 'vi',
        cancelState: { step: null, bookingCode: null, phoneVerified: false },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: '',
        summarizedMessageCount: 0,
        exitSubgraph: null,
      });

      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg).toBeInstanceOf(AIMessage);
      expect(lastMsg.content).toContain('<booking-step>service</booking-step>');
    });
  });

  describe('Cancellation Subgraph with interrupt()', () => {
    it('prompts for booking code when no code is provided', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn(),
      };

      const mockBookingService = {
        getBookingByCode: jest.fn(),
      } as unknown as BookingService;

      const mockChatGateway = {
        emitBookingCancellation: jest.fn(),
        emitBookingCancelled: jest.fn(),
      } as unknown as ChatGateway;

      const mockLogger = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      } as unknown as Logger;

      const mockServer = {
        to: jest.fn().mockReturnValue({ emit: jest.fn() }),
      } as unknown as SocketServer;

      const subgraph = buildCancellationSubgraph({
        toolProvider: mockToolProvider,
        bookingService: mockBookingService,
        logger: mockLogger,
        conversationId: 'test-conv-cancel',
        siteId: 'site-1',
        chatGateway: mockChatGateway,
        server: mockServer,
        clearActiveFlow: jest.fn().mockResolvedValue(undefined),
        activeConversationBookingCode: jest.fn().mockResolvedValue(undefined),
      });

      const result = await subgraph.invoke({
        messages: [new HumanMessage('Tôi muốn hủy lịch')],
        siteId: 'site-1',
        conversationId: 'test-conv-cancel',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          bookingServices: [],
          bookingResources: [],
          domains: [],
        },
        intent: 'cancel_booking',
        locale: 'vi',
        activeFlow: 'CANCELLATION',
        activeFlowLocale: 'vi',
        cancelState: { step: null, bookingCode: null, phoneVerified: false },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: '',
        summarizedMessageCount: 0,
        exitSubgraph: null,
      });

      expect(result.cancelState.step).toBe('ask_code');
      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg).toBeInstanceOf(AIMessage);
      expect(lastMsg.content).toContain('[cancel:ask_code|]');
    });
  });
});
