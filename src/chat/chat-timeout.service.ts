import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Conversation,
  ConversationStatus,
  HandlingStatus,
  ClosedReason,
} from './entities/conversation.entity';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { SenderType } from './entities/chat-message.entity';
import { Site } from '../site/entities/site.entity';

interface ConversationTimerHandle {
  timeoutHandle?: NodeJS.Timeout;
  warningHandle?: NodeJS.Timeout;
}

@Injectable()
export class ChatTimeoutService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatTimeoutService.name);
  private readonly conversationTimers = new Map<
    string,
    ConversationTimerHandle
  >();

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
  ) {}

  async onModuleInit() {
    this.logger.log(
      'Initializing ChatTimeoutService: Recovering active conversation timers...',
    );
    try {
      const activeConversations = await this.conversationRepository.find({
        where: {
          status: ConversationStatus.OPEN,
        },
        relations: {
          site: true,
        },
      });

      this.logger.log(
        `Found ${activeConversations.length} OPEN conversation(s) to schedule timers for.`,
      );

      for (const conversation of activeConversations) {
        this.scheduleTimers(
          conversation.id,
          conversation.site,
          conversation.lastActivityAt,
          conversation.handlingStatus,
        );
      }
    } catch (error) {
      this.logger.error('Failed to recover active conversation timers:', error);
    }
  }

  onModuleDestroy() {
    this.logger.log('Cleaning up all conversation timeout timers...');
    for (const handle of this.conversationTimers.values()) {
      if (handle.warningHandle) clearTimeout(handle.warningHandle);
      if (handle.timeoutHandle) clearTimeout(handle.timeoutHandle);
    }
    this.conversationTimers.clear();
  }

  /**
   * Schedule countdown timers (warning and timeout) for a conversation.
   */
  scheduleTimers(
    conversationId: string,
    site?: Site,
    lastActivityAt?: Date,
    handlingStatus?: HandlingStatus,
  ) {
    this.clearTimerHandles(conversationId);

    if (!site || !site.enableConversationTimeout) {
      if (this.chatGateway?.server) {
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('conversationTimerReset', { conversationId });
      }
      return;
    }

    if (
      site.pauseTimerForAgentChats &&
      handlingStatus === HandlingStatus.AGENT_HANDLING
    ) {
      this.logger.debug(
        `Conversation ${conversationId} is handled by agent; timer paused.`,
      );
      if (this.chatGateway?.server) {
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('conversationTimerReset', { conversationId });
      }
      return;
    }

    const timeoutMinutes = site.inactivityTimeoutMinutes || 15;
    const warningMinutes = site.warningTimeMinutes || 5;

    const timeoutMs = timeoutMinutes * 60 * 1000;
    const warningMs = Math.max(
      0,
      (timeoutMinutes - warningMinutes) * 60 * 1000,
    );

    const now = Date.now();
    const activityTime = lastActivityAt
      ? new Date(lastActivityAt).getTime()
      : now;
    const elapsed = Math.max(0, now - activityTime);

    const remainingTimeoutMs = timeoutMs - elapsed;
    const remainingWarningMs = warningMs - elapsed;

    // If timeout has already elapsed
    if (remainingTimeoutMs <= 0) {
      this.logger.log(
        `Conversation ${conversationId} has already timed out. Triggering close immediately.`,
      );
      void this.triggerTimeout(conversationId, site);
      return;
    }

    const timerHandle: ConversationTimerHandle = {};

    // Schedule Warning Timer
    if (remainingWarningMs <= 0) {
      // Past warning time, but not yet timed out: trigger warning immediately
      const remainingSeconds = Math.ceil(remainingTimeoutMs / 1000);
      void this.triggerWarning(conversationId, site, remainingSeconds);
    } else {
      // Still in safe period: dismiss any active warning on the client
      if (this.chatGateway?.server) {
        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('conversationTimerReset', { conversationId });
      }

      timerHandle.warningHandle = setTimeout(() => {
        void this.triggerWarning(conversationId, site, warningMinutes * 60);
      }, remainingWarningMs);
    }

    // Schedule Timeout Timer
    timerHandle.timeoutHandle = setTimeout(() => {
      void this.triggerTimeout(conversationId, site);
    }, remainingTimeoutMs);

    this.conversationTimers.set(conversationId, timerHandle);
    this.logger.debug(
      `Scheduled timers for conversation ${conversationId}: warning in ${Math.round(
        Math.max(0, remainingWarningMs) / 1000,
      )}s, timeout in ${Math.round(remainingTimeoutMs / 1000)}s`,
    );
  }

  /**
   * Reset the timers when new activity occurs in the conversation.
   */
  resetTimer(conversationId: string, site?: Site) {
    this.clearTimerHandles(conversationId);

    // Notify clients that timer has reset so they can dismiss any active warning banner
    if (this.chatGateway?.server) {
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('conversationTimerReset', { conversationId });
    }

    this.scheduleTimers(conversationId, site, new Date());
  }

  /**
   * Cancel and remove all timers for a conversation (e.g. when closed or deleted).
   */
  cancelTimer(conversationId: string) {
    this.clearTimerHandles(conversationId);
    this.conversationTimers.delete(conversationId);

    if (this.chatGateway?.server) {
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('conversationTimerReset', { conversationId });
    }
  }

  /**
   * Pause the timer (e.g. when assigned to an agent and pauseTimerForAgentChats is on).
   */
  pauseTimer(conversationId: string) {
    this.cancelTimer(conversationId);
  }

  /**
   * Refreshes timers for all OPEN conversations of a site (e.g. after site settings update).
   */
  async refreshSiteTimers(siteId: string) {
    try {
      const conversations = await this.conversationRepository.find({
        where: { siteId, status: ConversationStatus.OPEN },
        relations: { site: true },
      });

      for (const conv of conversations) {
        this.scheduleTimers(
          conv.id,
          conv.site,
          conv.lastActivityAt,
          conv.handlingStatus,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to refresh timers for site ${siteId}:`, err);
    }
  }

  private clearTimerHandles(conversationId: string) {
    const handle = this.conversationTimers.get(conversationId);
    if (handle) {
      if (handle.warningHandle) clearTimeout(handle.warningHandle);
      if (handle.timeoutHandle) clearTimeout(handle.timeoutHandle);
    }
  }

  private async triggerWarning(
    conversationId: string,
    site: Site,
    remainingSeconds: number,
  ) {
    try {
      const conversation = await this.conversationRepository.findOne({
        where: { id: conversationId },
      });

      if (!conversation || conversation.status === ConversationStatus.CLOSED) {
        this.cancelTimer(conversationId);
        return;
      }

      if (
        site.pauseTimerForAgentChats &&
        conversation.handlingStatus === HandlingStatus.AGENT_HANDLING
      ) {
        this.cancelTimer(conversationId);
        return;
      }

      let warningText =
        site.inactivityWarningMessage ||
        'It looks like you have been inactive for a while. Are you still there? This chat will close in {minutes} minutes if there is no response.';
      const minutesStr = Math.max(
        1,
        Math.ceil(remainingSeconds / 60),
      ).toString();
      warningText = warningText.replace(/\{minutes\}/g, minutesStr);

      this.logger.log(
        `Triggering inactivity warning for conversation: ${conversationId}`,
      );

      // Save system warning message to DB
      const warningMsg = await this.chatService.saveMessage(
        conversationId,
        warningText,
        SenderType.SYSTEM,
      );

      // Broadcast new message socket event
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('newMessage', {
          id: warningMsg.id,
          conversationId,
          content: warningText,
          senderType: SenderType.SYSTEM,
          createdAt: warningMsg.createdAt,
          status: 'DELIVERED',
        });

      // Broadcast explicit conversationWarning event for client UI banners
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('conversationWarning', {
          conversationId,
          remainingSeconds,
          message: warningText,
        });
    } catch (error) {
      this.logger.error(
        `Failed to trigger warning for conversation ${conversationId}:`,
        error,
      );
    }
  }

  private async triggerTimeout(conversationId: string, site: Site) {
    this.clearTimerHandles(conversationId);
    this.conversationTimers.delete(conversationId);

    try {
      const conversation = await this.conversationRepository.findOne({
        where: { id: conversationId },
      });

      if (!conversation || conversation.status === ConversationStatus.CLOSED) {
        return;
      }

      if (
        site.pauseTimerForAgentChats &&
        conversation.handlingStatus === HandlingStatus.AGENT_HANDLING
      ) {
        return;
      }

      this.logger.log(
        `Closing inactive conversation due to timeout: ${conversationId}`,
      );

      const timeoutText =
        site.timeoutMessage ||
        'This conversation has been closed due to inactivity. If you need further assistance, please start a new chat.';

      // Save timeout message
      try {
        const timeoutMsg = await this.chatService.saveMessage(
          conversationId,
          timeoutText,
          SenderType.SYSTEM,
        );

        this.chatGateway.server
          .to(`conversation-${conversationId}`)
          .emit('newMessage', {
            id: timeoutMsg.id,
            conversationId,
            content: timeoutText,
            senderType: SenderType.SYSTEM,
            createdAt: timeoutMsg.createdAt,
            status: 'DELIVERED',
          });
      } catch (e) {
        this.logger.error(
          `Failed to send timeout message for conversation ${conversationId}`,
          e,
        );
      }

      // Close the conversation
      await this.chatService.closeConversation(
        conversationId,
        ClosedReason.TIMEOUT,
      );
    } catch (error) {
      this.logger.error(
        `Failed to execute timeout closure for conversation ${conversationId}:`,
        error,
      );
    }
  }
}
