jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { UserRole } from '../user/enums/user-role.enum';
import {
  ConversationStatus,
  ClosedReason,
} from './entities/conversation.entity';
import {
  MessageStatus,
  SenderType,
  FeedbackRating,
  ChatMessage,
} from './entities/chat-message.entity';
import { createRepositoryMock } from '../test/service-test-helpers';

describe('ChatService saveMessage', () => {
  function makeService() {
    const siteRepository = createRepositoryMock();
    const conversationRepository = createRepositoryMock();
    const chatMessageRepository = createRepositoryMock();
    const userRepository = createRepositoryMock();
    const bookingService = { getBookingByCode: jest.fn() };
    const notificationService = { create: jest.fn() };
    const chatGateway = {
      notifyAgentsOfNewConversation: jest.fn(),
      notifyConversationClosed: jest.fn(),
      emitConversationStatusChanged: jest.fn(),
      server: { to: jest.fn().mockReturnThis(), emit: jest.fn() },
    };
    const graphService = {};
    const chatTimeoutService = {
      enqueueConversationSummaryEmail: jest.fn(),
      enqueueChatTranscriptEmail: jest.fn(),
      scheduleTimers: jest.fn(),
      resetTimer: jest.fn(),
      cancelTimer: jest.fn(),
      pauseTimer: jest.fn(),
      onModuleDestroy: jest.fn(),
    };
    const emailQueueService = { enqueueConversationSummaryEmail: jest.fn() };
    const aiService = { invoke: jest.fn() };
    // Mock moderation service — always safe so existing test behaviour is unchanged
    const moderationService = { isSafe: jest.fn().mockResolvedValue(true) };
    const jwtService = {
      signAsync: jest.fn().mockResolvedValue('mock-signed-visitor-token'),
      verifyAsync: jest.fn(),
    };
    const service = new ChatService(
      siteRepository as never,
      conversationRepository as never,
      chatMessageRepository as never,
      userRepository as never,
      bookingService as never,
      notificationService as never,
      chatGateway as never,
      graphService as never,
      chatTimeoutService as never,
      emailQueueService as never,
      aiService as never,
      moderationService,
      jwtService as never,
    );

    return {
      service,
      siteRepository,
      conversationRepository,
      chatMessageRepository,
      userRepository,
      jwtService,
      chatTimeoutService,
    };
  }

  it('blocks writes for closed conversations', async () => {
    const { service, conversationRepository, chatMessageRepository } =
      makeService();

    conversationRepository.findOne.mockResolvedValue({
      id: 'conv-1',
      siteId: 'site-1',
      status: ConversationStatus.CLOSED,
    });

    await expect(
      service.saveMessage('conv-1', 'hello', SenderType.VISITOR),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(chatMessageRepository.create).not.toHaveBeenCalled();
    expect(chatMessageRepository.save).not.toHaveBeenCalled();
  });

  describe('responseTimeSec (Turn-based Response Time Calculation)', () => {
    it('computes responseTimeSec when agent responds to a visitor message within 1 hour', async () => {
      const { service, conversationRepository, chatMessageRepository } =
        makeService();

      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      });

      const visitorCreatedAt = new Date(Date.now() - 45 * 1000); // 45s ago
      chatMessageRepository.findOne.mockResolvedValue({
        id: 'msg-visitor-1',
        conversationId: 'conv-1',
        senderType: SenderType.VISITOR,
        createdAt: visitorCreatedAt,
      });

      chatMessageRepository.create.mockImplementation((data: unknown) => {
        const payload = (
          typeof data === 'object' && data !== null ? data : {}
        ) as Partial<ChatMessage>;
        return {
          id: 'msg-agent-1',
          ...payload,
          createdAt: new Date(),
        };
      });
      chatMessageRepository.save.mockImplementation((msg: unknown) =>
        Promise.resolve(msg as ChatMessage),
      );

      const saved = await service.saveMessage(
        'conv-1',
        'Hello from agent',
        SenderType.AGENT,
        'agent-uuid-1',
      );

      expect(chatMessageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.AGENT,
          agentId: 'agent-uuid-1',
        }),
      );
      expect(typeof saved.responseTimeSec).toBe('number');
      expect(saved.responseTimeSec).toBeGreaterThanOrEqual(44);
      expect(saved.responseTimeSec).toBeLessThanOrEqual(46);
    });

    it('sets responseTimeSec to null when agent sends consecutive messages', async () => {
      const { service, conversationRepository, chatMessageRepository } =
        makeService();

      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      });

      chatMessageRepository.findOne.mockResolvedValue({
        id: 'msg-agent-1',
        conversationId: 'conv-1',
        senderType: SenderType.AGENT,
        createdAt: new Date(Date.now() - 10 * 1000),
      });

      chatMessageRepository.create.mockImplementation((data: unknown) => {
        const payload = (
          typeof data === 'object' && data !== null ? data : {}
        ) as Partial<ChatMessage>;
        return {
          id: 'msg-agent-2',
          ...payload,
          createdAt: new Date(),
        };
      });
      chatMessageRepository.save.mockImplementation((msg: unknown) =>
        Promise.resolve(msg as ChatMessage),
      );

      const saved = await service.saveMessage(
        'conv-1',
        'Follow-up message from agent',
        SenderType.AGENT,
        'agent-uuid-1',
      );

      expect(chatMessageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.AGENT,
          responseTimeSec: null,
        }),
      );
      expect(saved.responseTimeSec).toBeNull();
    });

    it('sets responseTimeSec to null when visitor message is older than 1 hour (3600s)', async () => {
      const { service, conversationRepository, chatMessageRepository } =
        makeService();

      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      });

      const oldVisitorTime = new Date(Date.now() - 4000 * 1000); // > 1 hour
      chatMessageRepository.findOne.mockResolvedValue({
        id: 'msg-visitor-old',
        conversationId: 'conv-1',
        senderType: SenderType.VISITOR,
        createdAt: oldVisitorTime,
      });

      chatMessageRepository.create.mockImplementation((data: unknown) => {
        const payload = (
          typeof data === 'object' && data !== null ? data : {}
        ) as Partial<ChatMessage>;
        return {
          id: 'msg-agent-1',
          ...payload,
          createdAt: new Date(),
        };
      });
      chatMessageRepository.save.mockImplementation((msg: unknown) =>
        Promise.resolve(msg as ChatMessage),
      );

      const saved = await service.saveMessage(
        'conv-1',
        'Delayed agent reply',
        SenderType.AGENT,
        'agent-uuid-1',
      );

      expect(chatMessageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.AGENT,
          responseTimeSec: null,
        }),
      );
      expect(saved.responseTimeSec).toBeNull();
    });

    it('sets responseTimeSec to null for VISITOR messages', async () => {
      const { service, conversationRepository, chatMessageRepository } =
        makeService();

      conversationRepository.findOne.mockResolvedValue({
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      });

      chatMessageRepository.create.mockImplementation((data: unknown) => {
        const payload = (
          typeof data === 'object' && data !== null ? data : {}
        ) as Partial<ChatMessage>;
        return {
          id: 'msg-visitor-1',
          ...payload,
          createdAt: new Date(),
        };
      });
      chatMessageRepository.save.mockImplementation((msg: unknown) =>
        Promise.resolve(msg as ChatMessage),
      );

      const saved = await service.saveMessage(
        'conv-1',
        'Hello from visitor',
        SenderType.VISITOR,
      );

      expect(chatMessageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.VISITOR,
          responseTimeSec: null,
        }),
      );
      expect(saved.responseTimeSec).toBeNull();
    });
  });

  it('exposes public conversation status without messages', async () => {
    const { service, conversationRepository } = makeService();

    conversationRepository.findOne.mockResolvedValue({
      id: 'conv-1',
      status: ConversationStatus.CLOSED,
      handlingStatus: 'AGENT_HANDLING',
    });

    await expect(
      service.getPublicConversationStatus('conv-1'),
    ).resolves.toEqual({
      conversationId: 'conv-1',
      status: ConversationStatus.CLOSED,
      handlingStatus: 'AGENT_HANDLING',
      closedReason: undefined,
    });
    expect(conversationRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      select: {
        id: true,
        status: true,
        handlingStatus: true,
        closedReason: true,
      },
    });
  });

  it('returns message senderName without exposing agent data', async () => {
    const { service, chatMessageRepository } = makeService();
    const createdAt = new Date('2026-08-05T10:00:00.000Z');

    chatMessageRepository.find.mockResolvedValue([
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderType: SenderType.AGENT,
        agentId: 'agent-1',
        content: 'hello',
        status: MessageStatus.SENT,
        createdAt,
        agent: { name: 'Lan Agent', password: 'secret' },
      },
    ]);

    await expect(service.getMessagesForConversation('conv-1')).resolves.toEqual(
      [
        {
          id: 'msg-1',
          conversationId: 'conv-1',
          senderType: SenderType.AGENT,
          agentId: 'agent-1',
          content: 'hello',
          status: MessageStatus.SENT,
          createdAt,
          senderName: 'Lan Agent',
        },
      ],
    );
  });

  it('updates public conversation status with CLEARED reason', async () => {
    const { service, conversationRepository } = makeService();
    const conv = {
      id: 'conv-1',
      siteId: 'site-1',
      status: ConversationStatus.OPEN,
      closedReason: null,
      visitorName: 'John Doe',
      visitorEmail: 'john@example.com',
      createdAt: new Date(),
      site: { owner: { id: 'owner-1' } },
    };

    conversationRepository.findOne.mockResolvedValue(conv);
    conversationRepository.update.mockResolvedValue({ affected: 1 });

    await service.updatePublicConversationStatus('conv-1', {
      status: ConversationStatus.CLOSED,
      reason: ClosedReason.CLEARED,
    });

    expect(conversationRepository.update).toHaveBeenCalledWith('conv-1', {
      status: ConversationStatus.CLOSED,
      closedReason: ClosedReason.CLEARED,
    });
  });

  describe('submitMessageFeedback', () => {
    it('successfully submits feedback on an AI message', async () => {
      const { service, chatMessageRepository } = makeService();
      const msg = {
        id: 'msg-ai-1',
        conversationId: 'conv-1',
        senderType: SenderType.AI,
        content: 'I can help with that.',
        feedbackRating: null,
        feedbackAt: null,
      };

      chatMessageRepository.findOne.mockResolvedValue(msg);
      chatMessageRepository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      const result = await service.submitMessageFeedback('msg-ai-1', {
        rating: FeedbackRating.HELPFUL,
      });

      expect(result).toEqual({
        id: 'msg-ai-1',
        feedbackRating: FeedbackRating.HELPFUL,
      });
      expect(chatMessageRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-ai-1',
          feedbackRating: FeedbackRating.HELPFUL,
        }),
      );
    });

    it('throws NotFoundException if message is not found', async () => {
      const { service, chatMessageRepository } = makeService();
      chatMessageRepository.findOne.mockResolvedValue(null);

      await expect(
        service.submitMessageFeedback('msg-not-found', {
          rating: FeedbackRating.UNHELPFUL,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException if message is not from AI', async () => {
      const { service, chatMessageRepository } = makeService();
      chatMessageRepository.findOne.mockResolvedValue({
        id: 'msg-agent-1',
        senderType: SenderType.AGENT,
      });

      await expect(
        service.submitMessageFeedback('msg-agent-1', {
          rating: FeedbackRating.UNHELPFUL,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('Security & Role Scoping (INTERNSHIP-210 & INTERNSHIP-209)', () => {
    it('allows SUPER_ADMIN to access conversation from any site/organization', async () => {
      const { service, conversationRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);

      const superAdminUser = {
        id: 'sa-1',
        email: 'super@admin.com',
        role: UserRole.SUPER_ADMIN,
        organizationId: 'org-other',
      };

      const result = await service.assertConversationSiteAccess(
        'conv-1',
        superAdminUser,
      );
      expect(result.id).toEqual('conv-1');
    });

    it('allows ADMIN to access conversation in the same organization', async () => {
      const { service, conversationRepository, siteRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);
      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        organizationId: 'org-1',
        agents: [],
      });

      const adminUser = {
        id: 'admin-1',
        email: 'admin@org1.com',
        role: UserRole.ADMIN,
        organizationId: 'org-1',
      };

      const result = await service.assertConversationSiteAccess(
        'conv-1',
        adminUser,
      );
      expect(result.id).toEqual('conv-1');
    });

    it('blocks ADMIN from accessing conversation of another organization (INTERNSHIP-210)', async () => {
      const { service, conversationRepository, siteRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);
      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        organizationId: 'org-1',
        agents: [],
      });

      const adminUserOrg2 = {
        id: 'admin-2',
        email: 'admin@org2.com',
        role: UserRole.ADMIN,
        organizationId: 'org-2',
      };

      await expect(
        service.assertConversationSiteAccess('conv-1', adminUserOrg2),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks AGENT not assigned to the site (INTERNSHIP-210)', async () => {
      const { service, conversationRepository, siteRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);
      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        organizationId: 'org-1',
        ownerId: 'owner-1',
        agents: [{ id: 'agent-other' }],
      });

      const unassignedAgent = {
        id: 'agent-1',
        email: 'agent@org1.com',
        role: UserRole.AGENT,
        organizationId: 'org-1',
      };

      await expect(
        service.assertConversationSiteAccess('conv-1', unassignedAgent),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('blocks deleteConversation if ADMIN does not own the organization (INTERNSHIP-210)', async () => {
      const { service, conversationRepository, siteRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);
      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        organizationId: 'org-1',
      });

      const adminUserOrg2 = {
        id: 'admin-2',
        email: 'admin@org2.com',
        role: UserRole.ADMIN,
        organizationId: 'org-2',
      };

      await expect(
        service.deleteConversation('conv-1', adminUserOrg2),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('emits subscribeError on handleSubscribeConversation if agent has no access (INTERNSHIP-209)', async () => {
      const { service, conversationRepository, siteRepository } = makeService();
      const conv = {
        id: 'conv-1',
        siteId: 'site-1',
        status: ConversationStatus.OPEN,
      };
      conversationRepository.findOne.mockResolvedValue(conv);
      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        organizationId: 'org-1',
        agents: [],
      });

      const client = {
        id: 'client-1',
        data: {
          user: {
            id: 'agent-1',
            email: 'agent@org2.com',
            role: UserRole.AGENT,
            organizationId: 'org-2',
          },
        },
        emit: jest.fn(),
        join: jest.fn(),
      } as unknown;

      await service.handleSubscribeConversation(client as never, {
        conversationId: 'conv-1',
      });

      expect((client as { emit: jest.Mock }).emit).toHaveBeenCalledWith(
        'subscribeError',
        expect.objectContaining({
          code: 403,
          message: 'You do not have access to this conversation',
        }),
      );
      expect((client as { join: jest.Mock }).join).not.toHaveBeenCalled();
    });
  });

  describe('createConversation visitorToken (INTERNSHIP-207)', () => {
    it('issues signed visitorToken when creating a conversation', async () => {
      const { service, siteRepository, conversationRepository, jwtService } =
        makeService();

      siteRepository.findOne.mockResolvedValue({
        id: 'site-1',
        enabled: true,
        isAiActive: true,
        ownerId: 'owner-1',
        agents: [],
      });

      const mockSavedConversation = {
        id: 'conv-123',
        siteId: 'site-1',
        visitorName: 'John Doe',
        visitorEmail: 'john@example.com',
        status: ConversationStatus.OPEN,
        handlingStatus: 'AI_HANDLING',
      };

      (
        conversationRepository as unknown as {
          manager: { transaction: jest.Mock };
        }
      ).manager = {
        transaction: jest
          .fn()
          .mockImplementation(
            (cb: (em: { create: jest.Mock; save: jest.Mock }) => unknown) => {
              const transactionalEntityManager = {
                create: jest.fn().mockReturnValue(mockSavedConversation),
                save: jest.fn().mockResolvedValue(mockSavedConversation),
              };
              return Promise.resolve(cb(transactionalEntityManager));
            },
          ),
      };

      const result = await service.createConversation({
        siteId: 'site-1',
        visitorName: 'John Doe',
        visitorEmail: 'john@example.com',
      });

      expect(jwtService.signAsync).toHaveBeenCalledWith(
        {
          sub: 'conv-123',
          conversationId: 'conv-123',
          siteId: 'site-1',
          type: 'visitor',
        },
        { expiresIn: '7d' },
      );
      expect(result.visitorToken).toBe('mock-signed-visitor-token');
      expect(result.conversationId).toBe('conv-123');
    });
  });
  describe('Server Shutdown Timer Cleanup', () => {
    it('cleans up all conversation timers on application shutdown', () => {
      const { service, chatTimeoutService } = makeService();
      service.beforeApplicationShutdown('SIGTERM');
      expect(chatTimeoutService.onModuleDestroy).toHaveBeenCalled();
    });
  });
});
