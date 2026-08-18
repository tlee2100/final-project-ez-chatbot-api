jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import { ChatTimeoutService } from './chat-timeout.service';
import {
  ConversationStatus,
  HandlingStatus,
  ClosedReason,
} from './entities/conversation.entity';
import { createRepositoryMock } from '../test/service-test-helpers';
import { Site } from '../site/entities/site.entity';
import { SenderType } from './entities/chat-message.entity';

describe('ChatTimeoutService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function makeService() {
    const conversationRepository = createRepositoryMock();
    const chatService = {
      saveMessage: jest.fn().mockResolvedValue({
        id: 'msg-1',
        createdAt: new Date().toISOString(),
      }),
      closeConversation: jest.fn().mockResolvedValue({
        id: 'conv-1',
        status: ConversationStatus.CLOSED,
      }),
    };
    const chatGateway = {
      server: {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      },
    };

    const service = new ChatTimeoutService(
      conversationRepository as never,
      chatService as never,
      chatGateway as never,
    );

    return {
      service,
      conversationRepository,
      chatService,
      chatGateway,
    };
  }

  it('does not schedule timers if timeout is disabled', () => {
    const { service } = makeService();
    const site = { enableConversationTimeout: false } as Site;

    service.scheduleTimers('conv-1', site, new Date());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('schedules warning and timeout timers when enabled', async () => {
    const { service, chatService, chatGateway, conversationRepository } =
      makeService();
    const site = {
      enableConversationTimeout: true,
      inactivityTimeoutMinutes: 10,
      warningTimeMinutes: 2,
      inactivityWarningMessage: 'Warning {minutes} min remaining',
      timeoutMessage: 'Closed due to timeout',
    } as Site;

    conversationRepository.findOne.mockResolvedValue({
      id: 'conv-1',
      status: ConversationStatus.OPEN,
    });

    service.scheduleTimers('conv-1', site, new Date());

    // Advance 8 minutes (10 - 2 = 8 minutes for warning)
    jest.advanceTimersByTime(8 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chatService.saveMessage).toHaveBeenCalledWith(
      'conv-1',
      'Warning 2 min remaining',
      SenderType.SYSTEM,
    );
    expect(chatGateway.server.emit).toHaveBeenCalledWith(
      'conversationWarning',
      {
        conversationId: 'conv-1',
        remainingSeconds: 120,
        message: 'Warning 2 min remaining',
      },
    );

    // Advance 2 more minutes (10 minutes total)
    jest.advanceTimersByTime(2 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chatService.saveMessage).toHaveBeenCalledWith(
      'conv-1',
      'Closed due to timeout',
      SenderType.SYSTEM,
    );
    expect(chatService.closeConversation).toHaveBeenCalledWith(
      'conv-1',
      ClosedReason.TIMEOUT,
    );
  });

  it('resets timers and emits conversationTimerReset on resetTimer', () => {
    const { service, chatGateway } = makeService();
    const site = {
      enableConversationTimeout: true,
      inactivityTimeoutMinutes: 10,
      warningTimeMinutes: 2,
    } as Site;

    service.scheduleTimers('conv-1', site, new Date());
    expect(jest.getTimerCount()).toBe(2);

    service.resetTimer('conv-1', site);
    expect(chatGateway.server.emit).toHaveBeenCalledWith(
      'conversationTimerReset',
      {
        conversationId: 'conv-1',
      },
    );
    expect(jest.getTimerCount()).toBe(2);
  });

  it('cancels timers and clears timer count on cancelTimer', () => {
    const { service, chatGateway } = makeService();
    const site = {
      enableConversationTimeout: true,
      inactivityTimeoutMinutes: 10,
      warningTimeMinutes: 2,
    } as Site;

    service.scheduleTimers('conv-1', site, new Date());
    expect(jest.getTimerCount()).toBe(2);

    service.cancelTimer('conv-1');
    expect(chatGateway.server.emit).toHaveBeenCalledWith(
      'conversationTimerReset',
      {
        conversationId: 'conv-1',
      },
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('recovers active timers on module init', async () => {
    const { service, conversationRepository } = makeService();
    const site = {
      enableConversationTimeout: true,
      inactivityTimeoutMinutes: 15,
      warningTimeMinutes: 5,
    } as Site;

    conversationRepository.find.mockResolvedValue([
      {
        id: 'conv-1',
        status: ConversationStatus.OPEN,
        handlingStatus: HandlingStatus.AI_HANDLING,
        lastActivityAt: new Date(),
        site,
      },
    ]);

    await service.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);
  });
});
