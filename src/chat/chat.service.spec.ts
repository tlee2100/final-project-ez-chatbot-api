jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { ForbiddenException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ConversationStatus } from './entities/conversation.entity';
import { MessageStatus, SenderType } from './entities/chat-message.entity';
import { createRepositoryMock } from '../test/service-test-helpers';

describe('ChatService saveMessage', () => {
  function makeService() {
    const siteRepository = createRepositoryMock();
    const conversationRepository = createRepositoryMock();
    const chatMessageRepository = createRepositoryMock();
    const userRepository = createRepositoryMock();
    const notificationService = { create: jest.fn() };
    const chatGateway = {
      notifyAgentsOfNewConversation: jest.fn(),
      notifyConversationClosed: jest.fn(),
      emitConversationStatusChanged: jest.fn(),
      server: { to: jest.fn().mockReturnThis(), emit: jest.fn() },
    };
    const graphService = {};
    const emailQueueService = { enqueueConversationSummaryEmail: jest.fn() };
    const aiService = { invoke: jest.fn() };

    const service = new ChatService(
      siteRepository as never,
      conversationRepository as never,
      chatMessageRepository as never,
      userRepository as never,
      notificationService as never,
      chatGateway as never,
      graphService as never,
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
    });
    expect(conversationRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      select: { id: true, status: true, handlingStatus: true },
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
});
