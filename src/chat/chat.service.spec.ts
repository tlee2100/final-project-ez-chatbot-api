jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import {
  ConversationStatus,
  ClosedReason,
} from './entities/conversation.entity';
import {
  MessageStatus,
  SenderType,
  FeedbackRating,
} from './entities/chat-message.entity';
import { createRepositoryMock } from '../test/service-test-helpers';

describe('ChatService saveMessage', () => {
  function makeService() {
    const siteRepository = createRepositoryMock();
    const conversationRepository = createRepositoryMock();
    const chatMessageRepository = createRepositoryMock();
    const userRepository = createRepositoryMock();
    const bookingRepository = createRepositoryMock();
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
    };
    const emailQueueService = { enqueueConversationSummaryEmail: jest.fn() };
    const aiService = { invoke: jest.fn() };
    const service = new ChatService(
      siteRepository as never,
      conversationRepository as never,
      chatMessageRepository as never,
      userRepository as never,
      bookingRepository as never,
      notificationService as never,
      chatGateway as never,
      graphService as never,
      chatTimeoutService as never,
      emailQueueService as never,
      aiService as never,
    );

    return {
      service,
      conversationRepository,
      chatMessageRepository,
      userRepository,
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
        id: 'msg-user-1',
        senderType: SenderType.VISITOR,
      });

      await expect(
        service.submitMessageFeedback('msg-user-1', {
          rating: FeedbackRating.UNHELPFUL,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
