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

const invokedSystemPrompt = (invokeMock: jest.Mock): string => {
  const calls = invokeMock.mock.calls as unknown[][];
  const messages = calls[0]?.[0];
  if (!Array.isArray(messages)) return '';

  const firstMessage: unknown = messages[0];
  if (
    !firstMessage ||
    typeof firstMessage !== 'object' ||
    !('content' in firstMessage)
  ) {
    return '';
  }

  const content = firstMessage.content;
  return typeof content === 'string' ? content : '';
};

describe('LangGraph Subgraphs & Interrupts', () => {
  describe('Knowledge Subgraph', () => {
    it('returns knowledge fallback message when retrieval fails', async () => {
      const executeMock = jest.fn().mockRejectedValue(new Error('KB Offline'));
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: executeMock,
      };

      const buildModelForSiteMock = jest.fn();
      const mockAiService = {
        buildSystemPrompt: jest.fn().mockReturnValue('System Prompt'),
        buildModelForSite: buildModelForSiteMock,
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
      expect(buildModelForSiteMock).not.toHaveBeenCalled();
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
      expect(invokedSystemPrompt(invokeMock)).toContain(
        'directly supported by CURRENT PAGE CONTEXT',
      );
    });

    it('uses current page context when knowledge retrieval is unavailable', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn().mockRejectedValue(new Error('KB Offline')),
      };
      const invokeMock = jest
        .fn()
        .mockResolvedValue(new AIMessage('The page price is $10.'));
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
        conversationId: 'test-conv-page-kb-error',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          maxTokensPerResponse: 500,
        },
        server: mockServer,
      });

      const result = await subgraph.invoke({
        messages: [new HumanMessage('What is the price on this page?')],
        siteId: 'site-1',
        conversationId: 'test-conv-page-kb-error',
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

      expect(result.knowledgeSearchStatus).toBe('error');
      expect(buildSystemPromptMock).toHaveBeenCalledWith(
        expect.objectContaining({ pageContext }),
      );
      expect(invokedSystemPrompt(invokeMock)).toMatch(
        /Knowledge retrieval is currently unavailable[\s\S]*directly supported by CURRENT PAGE CONTEXT/,
      );
    });
  });

  describe('Booking Subgraph with interrupt()', () => {
    it('generates initial booking_type prompt on book_appointment_init for salon template', async () => {
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
            industryTemplateId: 'salon',
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
          industryTemplateId: 'salon',
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
      expect(lastMsg.content).toContain(
        '<booking-step>booking_type</booking-step>',
      );
    });

    it('generates initial booking_type prompt on generic book_appointment intent for salon template', async () => {
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
        conversationId: 'test-conv-book-generic',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          siteContext: {
            bookingEnabled: true,
            industryTemplateId: 'salon',
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
        messages: [new HumanMessage('i book')],
        siteId: 'site-1',
        conversationId: 'test-conv-book-generic',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          industryTemplateId: 'salon',
          bookingServices: [{ id: 's1', name: 'Service 1' }],
          bookingResources: [{ id: 'r1', name: 'Staff 1' }],
          domains: [],
        },
        intent: 'book_appointment',
        locale: 'en',
        activeFlow: 'BOOKING',
        activeFlowLocale: 'en',
        cancelState: { step: null, bookingCode: null, phoneVerified: false },
        knowledgeSources: [],
        knowledgeSearchStatus: 'idle',
        summary: '',
        summarizedMessageCount: 0,
        exitSubgraph: null,
      });

      const lastMsg = result.messages[result.messages.length - 1];
      expect(lastMsg).toBeInstanceOf(AIMessage);
      expect(lastMsg.content).toContain(
        '<booking-step>booking_type</booking-step>',
      );
      expect(lastMsg.content).toContain(
        'Would you like to book for 1 person or for a group of multiple people?',
      );
    });

    it('generates initial service prompt directly for general template', async () => {
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
        conversationId: 'test-conv-book-general',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          siteContext: {
            bookingEnabled: true,
            industryTemplateId: 'general',
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
        messages: [new HumanMessage('Tôi muốn đặt sân')],
        siteId: 'site-1',
        conversationId: 'test-conv-book-general',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          industryTemplateId: 'general',
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

    it('prompts party_size when multiple is selected in salon template', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn(),
      };

      const subgraph = buildBookingSubgraph({
        toolProvider: mockToolProvider,
        aiService: {} as AiService,
        logger: {
          log: jest.fn(),
          error: jest.fn(),
          warn: jest.fn(),
        } as unknown as Logger,
        conversationId: 'test-conv-party',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          siteContext: {
            bookingEnabled: true,
            industryTemplateId: 'salon',
            bookingServices: [{ id: 's1', name: 'Gội đầu' }],
            bookingResources: [
              { id: 'r1', name: 'Thợ A' },
              { id: 'r2', name: 'Thợ B' },
            ],
          },
          visitorContext: {},
        },
        chatGateway: {
          emitBookingSummary: jest.fn(),
          emitBookingSuccess: jest.fn(),
          emitBookingSlots: jest.fn(),
        } as unknown as ChatGateway,
        server: {
          to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        } as unknown as SocketServer,
        bookingTools: [],
        clearActiveFlow: jest.fn().mockResolvedValue(undefined),
      });

      const result = await subgraph.invoke({
        messages: [
          new HumanMessage('Tôi muốn đặt lịch'),
          new AIMessage(
            'Bạn muốn đặt lịch cho 1 người hay cho nhóm nhiều người?\n\n<booking-step>booking_type</booking-step>',
          ),
          new HumanMessage(
            '/select-booking-option {"action":"select_booking_type","value":"multiple"} :: Đặt cho nhiều người',
          ),
        ],
        siteId: 'site-1',
        conversationId: 'test-conv-party',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          industryTemplateId: 'salon',
          bookingServices: [{ id: 's1', name: 'Gội đầu' }],
          bookingResources: [
            { id: 'r1', name: 'Thợ A' },
            { id: 'r2', name: 'Thợ B' },
          ],
          domains: [],
        },
        intent: 'structured_booking_step',
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
      expect(lastMsg.content).toContain(
        '<booking-step>party_size</booking-step>',
      );
    });

    it('enforces 1-to-1 matching for single person booking with multiple services', async () => {
      const mockToolProvider: IToolProvider = {
        listTools: jest.fn().mockResolvedValue([]),
        execute: jest.fn().mockResolvedValue({ output: { slots: [] } }),
      };

      const subgraph = buildBookingSubgraph({
        toolProvider: mockToolProvider,
        aiService: {} as AiService,
        logger: {
          log: jest.fn(),
          error: jest.fn(),
          warn: jest.fn(),
        } as unknown as Logger,
        conversationId: 'test-conv-single-mismatch',
        siteId: 'site-1',
        options: {
          site: { id: 'site-1' },
          siteContext: {
            bookingEnabled: true,
            industryTemplateId: 'salon',
            bookingServices: [
              { id: 's1', name: 'Gội đầu' },
              { id: 's2', name: 'Cắt tóc' },
            ],
            bookingResources: [{ id: 'r1', name: 'Thợ A' }],
          },
          visitorContext: {},
        },
        chatGateway: {
          emitBookingSummary: jest.fn(),
          emitBookingSuccess: jest.fn(),
          emitBookingSlots: jest.fn(),
        } as unknown as ChatGateway,
        server: {
          to: jest.fn().mockReturnValue({ emit: jest.fn() }),
        } as unknown as SocketServer,
        bookingTools: [],
        clearActiveFlow: jest.fn().mockResolvedValue(undefined),
      });

      const result = await subgraph.invoke({
        messages: [
          new HumanMessage('Tôi muốn đặt lịch'),
          new AIMessage(
            'Bạn muốn đặt lịch cho 1 người hay cho nhóm nhiều người?\n\n<booking-step>booking_type</booking-step>',
          ),
          new HumanMessage(
            '/select-booking-option {"action":"select_booking_type","value":"single"} :: Đặt cho 1 người',
          ),
          new AIMessage(
            'Bạn muốn đặt dịch vụ nào?\n\n<booking-step>service</booking-step>',
          ),
          new HumanMessage(
            '/select-booking-option {"action":"select_service","value":"s1,s2"} :: Gội đầu, Cắt tóc',
          ),
          new HumanMessage(
            '/select-booking-slot {"date":"2026-08-27","timeSlot":"09:00","slotCount":1} :: 09:00',
          ),
        ],
        siteId: 'site-1',
        conversationId: 'test-conv-single-mismatch',
        visitorContext: {},
        siteContext: {
          bookingEnabled: true,
          industryTemplateId: 'salon',
          bookingServices: [
            { id: 's1', name: 'Gội đầu' },
            { id: 's2', name: 'Cắt tóc' },
          ],
          bookingResources: [{ id: 'r1', name: 'Thợ A' }],
          domains: [],
        },
        intent: 'structured_booking_step',
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
      expect(lastMsg.content).toContain(
        'Bạn đang đặt lịch cho 1 người với 2 dịch vụ',
      );
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
