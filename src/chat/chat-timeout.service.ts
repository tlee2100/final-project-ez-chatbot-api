import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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

@Injectable()
export class ChatTimeoutService {
  private readonly logger = new Logger(ChatTimeoutService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Cron('*/10 * * * * *')
  async handleInactiveConversations() {
    this.logger.debug('Running inactive conversation timeout check...');

    // Fetch all OPEN conversations along with their site configuration
    const activeConversations = await this.conversationRepository.find({
      where: {
        status: ConversationStatus.OPEN,
      },
      relations: {
        site: true,
      },
    });

    const now = new Date().getTime();

    for (const conversation of activeConversations) {
      const site = conversation.site;

      if (!site || !site.enableConversationTimeout) {
        continue;
      }

      // Skip agent-handled chats if configured to pause timer
      if (
        site.pauseTimerForAgentChats &&
        conversation.handlingStatus === HandlingStatus.AGENT_HANDLING
      ) {
        continue;
      }

      const timeoutMs = (site.inactivityTimeoutMinutes || 15) * 60 * 1000;
      const lastActivityTime = new Date(conversation.lastActivityAt).getTime();

      if (now - lastActivityTime >= timeoutMs) {
        this.logger.log(`Closing inactive conversation: ${conversation.id}`);

        // Send a timeout message before closing
        if (site.timeoutMessage) {
          try {
            await this.chatService.saveMessage(
              conversation.id,
              site.timeoutMessage,
              SenderType.SYSTEM,
            );

            this.chatGateway.server
              .to(`conversation-${conversation.id}`)
              .emit('newMessage', {
                conversationId: conversation.id,
                content: site.timeoutMessage,
                senderType: SenderType.SYSTEM,
                createdAt: new Date().toISOString(),
                status: 'SENT',
              });
          } catch (e) {
            this.logger.error(
              `Failed to send timeout message for conversation ${conversation.id}`,
              e,
            );
          }
        }

        // Close the conversation (this emits the necessary events to agents and visitors)
        try {
          await this.chatService.closeConversation(
            conversation.id,
            ClosedReason.TIMEOUT,
          );
        } catch (error) {
          this.logger.error(
            `Failed to close conversation ${conversation.id}`,
            error,
          );
        }
      }
    }
  }
}
