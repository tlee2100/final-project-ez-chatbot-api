import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import {
  paginate,
  Paginated,
  FilterOperator,
  FilterSuffix,
} from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Brackets, In } from 'typeorm';
import { Site } from '../site/entities/site.entity';
import { UserRole } from '../user/enums/user-role.enum';
import {
  Conversation,
  ConversationStatus,
  HandlingStatus,
  ClosedReason,
} from './entities/conversation.entity';
import {
  ChatMessage,
  SenderType,
  MessageStatus,
} from './entities/chat-message.entity';
import { User } from '../user/entities/user.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { JwtUser } from '../auth/types/jwt-user.type';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/enums/notification-type.enum';
import { EmailQueueService } from '../notification/email-queue.service';
import { ChatGateway, SocketData, ChatMessagePayload } from './chat.gateway';
import { GraphService } from './graph.service';
import { ChatTimeoutService } from './chat-timeout.service';
import { CreateConversationResponseDto } from './dto/create-conversation-response.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';
import { AiService } from './ai.service';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { Booking } from '../booking/entities/booking.entity';
import { latestActiveBookingCode } from './booking-cancellation.utils';

type ChatMessageDto = Pick<
  ChatMessage,
  | 'id'
  | 'conversationId'
  | 'senderType'
  | 'agentId'
  | 'content'
  | 'status'
  | 'createdAt'
> & {
  senderName?: string | null;
};
const MAX_MESSAGE_LENGTH = 1000;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly conversationsClosedListeners = new Set<
    (ids: string[]) => void
  >();

  private readonly conversationPresence = new Map<
    string,
    { agent: Set<string>; visitor: Set<string> }
  >();

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly chatMessageRepository: Repository<ChatMessage>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Booking)
    private readonly bookingRepository: Repository<Booking>,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => GraphService))
    private readonly graphService: GraphService,
    @Inject(forwardRef(() => ChatTimeoutService))
    private readonly chatTimeoutService: ChatTimeoutService,
    private readonly emailQueueService: EmailQueueService,
    private readonly aiService: AiService,
  ) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }

  onModuleInit() {
    // Moved to chat-timeout.service.ts
  }

  onModuleDestroy() {
    // Moved to chat-timeout.service.ts
  }

  onConversationsClosed(listener: (ids: string[]) => void) {
    this.conversationsClosedListeners.add(listener);
    return () => this.conversationsClosedListeners.delete(listener);
  }

  // ─── Presence Tracking ───────────────────────────────────────────────────

  private trackConversationPresence(client: Socket, conversationId: string) {
    const socketData = client.data as SocketData;
    const senderType = socketData.user ? SenderType.AGENT : SenderType.VISITOR;
    const presence = this.conversationPresence.get(conversationId) ?? {
      agent: new Set<string>(),
      visitor: new Set<string>(),
    };
    const key = senderType === SenderType.AGENT ? 'agent' : 'visitor';
    presence[key].add(client.id);
    this.conversationPresence.set(conversationId, presence);
  }

  private untrackConversationPresence(client: Socket) {
    this.conversationPresence.forEach((presence, conversationId) => {
      presence.agent.delete(client.id);
      presence.visitor.delete(client.id);
      if (presence.agent.size === 0 && presence.visitor.size === 0) {
        this.conversationPresence.delete(conversationId);
      }
    });
  }

  private hasConversationPresence(
    conversationId: string,
    senderType: SenderType,
  ) {
    const presence = this.conversationPresence.get(conversationId);
    if (!presence) return false;
    return senderType === SenderType.AGENT
      ? presence.agent.size > 0
      : presence.visitor.size > 0;
  }

  // ─── WebSocket Connection Handlers ────────────────────────────────────────

  async handleConnection(client: Socket): Promise<void> {
    const socketData = client.data as SocketData;
    const user = socketData.user;
    const visitor = socketData.visitor;

    if (!user && !visitor) {
      client.disconnect();
      return;
    }

    if (visitor) {
      if (visitor.conversationId) {
        this.logger.log(
          `Visitor connected for conversation ${visitor.conversationId}`,
        );
        void client.join(`conversation-${visitor.conversationId}`);
        this.trackConversationPresence(client, visitor.conversationId);

        const receiverType = SenderType.VISITOR;
        if (!visitor.conversationId.startsWith('admin-test-')) {
          await this.markConversationDelivered(
            visitor.conversationId,
            receiverType,
          );
          this.chatGateway.server
            .to(`conversation-${visitor.conversationId}`)
            .emit('conversation-delivered', {
              conversationId: visitor.conversationId,
              receiverType,
            });
        }

        client.emit('connected', { message: `Connected as visitor` });
      }

      if (visitor.siteId) {
        this.logger.log(
          `Visitor connected to site ${visitor.siteId} for realtime settings`,
        );
        void client.join(`site-${visitor.siteId}`);
        if (!visitor.conversationId) {
          client.emit('connected', {
            message: `Connected to site ${visitor.siteId}`,
          });
        }
      }
      return;
    }

    if (!user) return;

    this.logger.log(`Client connected: ${client.id} (${user.email})`);

    // Join site rooms for inbox real-time updates
    await this.handleClientConnected((room) => void client.join(room), user);

    client.emit('connected', { message: `Connected as ${user.email}` });
  }

  handleDisconnect(client: Socket): void {
    this.untrackConversationPresence(client);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Called when an authenticated agent WebSocket client connects.
   * Joins them into notification rooms for each site they own or are assigned to.
   */
  async handleClientConnected(
    clientJoin: (room: string) => void,
    user: JwtUser,
  ): Promise<void> {
    const ownedSites = await this.siteRepository.find({
      where: { ownerId: user.id },
    });
    const assignedSites = await this.siteRepository
      .createQueryBuilder('site')
      .innerJoin('site.agents', 'agent', 'agent.id = :userId', {
        userId: user.id,
      })
      .getMany();

    const allSiteIds = new Set([
      ...ownedSites.map((s) => s.id),
      ...assignedSites.map((s) => s.id),
    ]);

    for (const siteId of allSiteIds) {
      clientJoin(`site-${siteId}`);
    }

    this.logger.log(
      `User ${user.email} connected. Joined site rooms: [${[...allSiteIds].join(', ')}]`,
    );
  }

  // ─── WebSocket Event Handlers ─────────────────────────────────────────────

  handleLegacyMessage(client: Socket, payload: ChatMessagePayload): string {
    const socketData = client.data as SocketData;
    const user = socketData.user;

    if (!user) {
      throw new WsException('Unauthenticated client');
    }

    const message = this.validateMessagePayload(payload);
    const sender = user.email;
    const text = `${sender}: ${message}`;

    this.logger.log(`Message received from ${sender}: ${message}`);
    this.chatGateway.server.emit('message', text);

    return message;
  }

  async handleJoinConversation(
    client: Socket,
    payload: { conversationId: string },
  ): Promise<void> {
    const user = (client.data as SocketData).user;
    if (!user) {
      client.emit('joinError', { message: 'Unauthenticated' });
      return;
    }

    try {
      const { conversation, isNewAssignment } =
        await this.assignAgentToConversation(payload.conversationId, user);

      client.emit('chatTaken', {
        success: true,
        conversationId: conversation.id,
      });

      void client.join(`conversation-${payload.conversationId}`);
      this.trackConversationPresence(client, payload.conversationId);

      const receiverType = SenderType.AGENT;
      await this.markConversationRead(payload.conversationId, receiverType);
      this.chatGateway.server
        .to(`conversation-${payload.conversationId}`)
        .emit('conversation-read', {
          conversationId: payload.conversationId,
          readerType: receiverType,
        });

      this.logger.log(
        `Agent ${user.email} joined conversation ${payload.conversationId}`,
      );

      client.emit('joinedConversation', {
        conversationId: payload.conversationId,
        isNewAssignment,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to join conversation';
      client.emit('joinError', { message });
    }
  }

  async handleSubscribeConversation(
    client: Socket,
    payload: { conversationId: string },
  ): Promise<void> {
    void client.join(`conversation-${payload.conversationId}`);
    this.trackConversationPresence(client, payload.conversationId);

    const socketData = client.data as SocketData;
    if (socketData.user) {
      const receiverType = SenderType.AGENT;
      await this.markConversationDelivered(
        payload.conversationId,
        receiverType,
      );
      this.chatGateway.server
        .to(`conversation-${payload.conversationId}`)
        .emit('conversation-delivered', {
          conversationId: payload.conversationId,
          receiverType,
        });
    }

    this.logger.log(
      `Client ${client.id} subscribed to conversation ${payload.conversationId}`,
    );
  }

  async handleSendMessage(
    client: Socket,
    payload: {
      conversationId: string;
      content: string;
      senderType: SenderType;
      localId?: string;
    },
  ): Promise<void> {
    const socketData = client.data as SocketData;
    const user = socketData.user;
    const visitor = socketData.visitor;

    if (!user && !visitor) {
      client.emit('messageError', { message: 'Unauthenticated' });
      return;
    }

    if (visitor) {
      if (visitor.conversationId !== payload.conversationId) {
        client.emit('messageError', { message: 'Unauthorized conversation' });
        return;
      }
      payload.senderType = SenderType.VISITOR;
    } else if (user) {
      payload.senderType = SenderType.AGENT;
    }

    // Ephemeral in-memory test conversation (sandbox mode)
    if (payload.conversationId.startsWith('admin-test-')) {
      const siteId =
        visitor?.siteId || (client.handshake.query.siteId as string);
      const messageEvent = {
        id: payload.localId || `msg-test-${Date.now()}`,
        conversationId: payload.conversationId,
        content: payload.content,
        senderType: SenderType.VISITOR,
        createdAt: new Date().toISOString(),
        status: MessageStatus.SENT,
      };

      client.emit('messageSaved', {
        localId: payload.localId,
        ...messageEvent,
      });

      client
        .to(`conversation-${payload.conversationId}`)
        .emit('newMessage', messageEvent);

      this.graphService
        .handleVisitorMessage(
          payload.conversationId,
          siteId,
          undefined,
          undefined,
          payload.content,
        )
        .catch((err: unknown) =>
          this.logger.error(
            `AI test stream error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }

    try {
      const { savedMessage, conversation } = await this.processIncomingMessage(
        payload.conversationId,
        payload.content,
        payload.senderType,
        payload.senderType === SenderType.AGENT ? user?.id : undefined,
      );

      const receiverType = user ? SenderType.VISITOR : SenderType.AGENT;
      if (this.hasConversationPresence(payload.conversationId, receiverType)) {
        await this.markConversationDelivered(
          payload.conversationId,
          receiverType,
        );
        savedMessage.status = MessageStatus.DELIVERED;
        this.chatGateway.server
          .to(`conversation-${payload.conversationId}`)
          .emit('conversation-delivered', {
            conversationId: payload.conversationId,
            receiverType,
          });
      }

      const messageEvent = {
        id: savedMessage.id,
        conversationId: payload.conversationId,
        content: savedMessage.content,
        senderType: savedMessage.senderType,
        agentId: savedMessage.agentId,
        senderName: savedMessage.agent?.name,
        createdAt: savedMessage.createdAt,
        status: savedMessage.status,
      };

      // Broadcast to everyone else in the room
      client
        .to(`conversation-${payload.conversationId}`)
        .emit('newMessage', messageEvent);

      // Echo back to sender with real DB id
      client.emit('messageSaved', {
        localId: payload.localId,
        ...messageEvent,
      });

      // Automatically trigger AI if the visitor sent the message and AI is active
      if (payload.senderType === SenderType.VISITOR) {
        // Run in background so we don't block the WebSocket response
        this.graphService
          .handleVisitorMessage(
            payload.conversationId,
            conversation.siteId,
            undefined,
            async (text: string) => {
              const fullSite = await this.siteRepository.findOne({
                where: { id: conversation.siteId },
                relations: { agents: true },
              });
              if (fullSite) {
                const userIds = [
                  fullSite.ownerId,
                  ...fullSite.agents.map((a) => a.id),
                ];
                await this.notificationService.emitSentimentAlert(
                  userIds,
                  fullSite.id,
                  payload.conversationId,
                  text,
                );
              }
            },
          )
          .catch((err: unknown) =>
            this.logger.error(
              `AI stream error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to send message';
      client.emit('messageError', { message });
    }
  }

  handleTyping(client: Socket, payload: { conversationId: string }): void {
    const socketData = client.data as SocketData;
    const user = socketData.user;
    const visitor = socketData.visitor;

    if (!user && !visitor) return;

    if (visitor && visitor.conversationId !== payload.conversationId) return;

    const senderType = visitor ? SenderType.VISITOR : SenderType.AGENT;

    // Broadcast typing event to the room
    client
      .to(`conversation-${payload.conversationId}`)
      .emit('conversation-typing', {
        conversationId: payload.conversationId,
        senderType,
      });
  }

  async handleConversationRead(
    client: Socket,
    payload: { conversationId: string },
  ): Promise<void> {
    const socketData = client.data as SocketData;
    if (!socketData.user && !socketData.visitor) return;

    const readerType = socketData.user ? SenderType.AGENT : SenderType.VISITOR;
    await this.markConversationRead(payload.conversationId, readerType);
    this.chatGateway.server
      .to(`conversation-${payload.conversationId}`)
      .emit('conversation-read', {
        conversationId: payload.conversationId,
        readerType,
      });
  }

  // ─── Create Conversation ───────────────────────────────────────────────────

  async createConversation(
    dto: CreateConversationDto,
  ): Promise<CreateConversationResponseDto> {
    const site = await this.siteRepository.findOne({
      where: { id: dto.siteId },
      relations: { agents: true },
    });
    if (!site) {
      throw new NotFoundException(`Site ${dto.siteId} not found`);
    }
    if (!site.isAiActive) {
      throw new ForbiddenException(
        'Chatbot is currently disabled for this site',
      );
    }

    const result = await this.conversationRepository.manager.transaction(
      async (transactionalEntityManager) => {
        const conversation = transactionalEntityManager.create(Conversation, {
          siteId: dto.siteId,
          visitorName: dto.visitorName,
          visitorEmail: dto.visitorEmail,
          status: ConversationStatus.OPEN,
          handlingStatus: HandlingStatus.AI_HANDLING,
          lastActivityAt: new Date(),
        });
        const savedConversation = await transactionalEntityManager.save(
          Conversation,
          conversation,
        );

        if (site.defaultGreetingMessage) {
          const greetingMessage = transactionalEntityManager.create(
            ChatMessage,
            {
              conversationId: savedConversation.id,
              content: site.defaultGreetingMessage,
              senderType: SenderType.AI,
              status: MessageStatus.DELIVERED,
            },
          );
          await transactionalEntityManager.save(ChatMessage, greetingMessage);
        }

        this.chatGateway.notifyAgentsOfNewConversation(savedConversation);

        return {
          conversationId: savedConversation.id,
          siteId: savedConversation.siteId,
          visitorName: savedConversation.visitorName,
          visitorEmail: savedConversation.visitorEmail,
          status: savedConversation.status,
          handlingStatus: savedConversation.handlingStatus,
        };
      },
    );

    this.logger.log(
      `New conversation ${result.conversationId} created for site ${dto.siteId}`,
    );

    // Schedule inactivity timeout & warning timers for the new conversation
    this.chatTimeoutService.scheduleTimers(
      result.conversationId,
      site,
      new Date(),
      result.handlingStatus,
    );

    // Notify agents AFTER the transaction commits so the foreign key constraint passes
    const recipientIds = new Set([
      site.ownerId,
      ...site.agents.map((a) => a.id),
    ]);
    for (const userId of recipientIds) {
      try {
        await this.notificationService.create({
          recipientId: userId,
          type: NotificationType.CONVERSATION_WAITING,
          title: 'New Conversation Started',
          message: `${dto.visitorName && dto.visitorName !== '[NONE]' ? dto.visitorName : 'A visitor'} has started a new conversation. The AI is currently handling it — you may take over anytime.`,
          siteId: site.id,
          conversationId: result.conversationId,
        });
      } catch (error) {
        this.logger.error(
          `Failed to notify user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  }

  // ─── Admin: Create Test Conversation ──────────────────────────────────────

  /**
   * Creates a temporary "test" conversation for an authenticated admin/owner.
   *
   * Security checks (in order):
   * 1. Site must exist.
   * 2. Requesting user must be the site owner OR a SUPER_ADMIN.
   *    (Agents are not permitted — they should use the live inbox.)
   *
   * The conversation is tagged with a synthetic visitor identity so the AI
   * pipeline works normally, and it does NOT fire agent notifications (unlike
   * the public createConversation) to avoid polluting the inbox.
   */
  async assertSiteAccessForTest(siteId: string, user: JwtUser): Promise<Site> {
    const site = await this.siteRepository.findOne({
      where: { id: siteId },
      select: {
        id: true,
        ownerId: true,
        organizationId: true,
        name: true,
        enableConversationTimeout: true,
        inactivityTimeoutMinutes: true,
        warningTimeMinutes: true,
        inactivityWarningMessage: true,
        timeoutMessage: true,
        resetTimerOnBotResponse: true,
        pauseTimerForAgentChats: true,
      },
    });

    if (!site) {
      throw new NotFoundException(`Site ${siteId} not found`);
    }

    const isSuperAdmin = user.role === UserRole.SUPER_ADMIN;
    const isOwner = site.ownerId === user.id;
    const isOrgAdmin =
      user.role === UserRole.ADMIN &&
      user.organizationId !== null &&
      site.organizationId === user.organizationId;
    if (!isSuperAdmin && !isOwner && !isOrgAdmin) {
      throw new ForbiddenException(
        'You do not have permission to test this site',
      );
    }

    return site;
  }

  async createAdminTestConversation(
    siteId: string,
    user: JwtUser,
  ): Promise<CreateConversationResponseDto> {
    const site = await this.assertSiteAccessForTest(siteId, user);

    const conversation = this.conversationRepository.create({
      siteId,
      visitorName: `Admin Test — ${user.email}`,
      visitorEmail: user.email,
      status: ConversationStatus.OPEN,
      handlingStatus: HandlingStatus.AI_HANDLING,
      lastActivityAt: new Date(),
    });

    const saved = await this.conversationRepository.save(conversation);

    this.logger.log(
      `[AdminTest] Test conversation ${saved.id} created for site ${siteId} by admin ${user.email}`,
    );

    // Schedule timers for test conversation
    this.chatTimeoutService.scheduleTimers(
      saved.id,
      site,
      saved.lastActivityAt,
      saved.handlingStatus,
    );

    // Intentionally NO agent notifications for test conversations.

    return {
      conversationId: saved.id,
      siteId: saved.siteId,
      visitorName: saved.visitorName,
      visitorEmail: saved.visitorEmail,
      status: saved.status,
      handlingStatus: saved.handlingStatus,
    };
  }

  // ─── Escalate to Agent ─────────────────────────────────────────────────────

  async escalateToAgent(conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: { site: { agents: true } },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    if (conversation.handlingStatus === HandlingStatus.AGENT_HANDLING) {
      return conversation; // Already handled
    }

    conversation.handlingStatus = HandlingStatus.WAITING_FOR_AGENT;
    conversation.isAiActive = false;
    const savedConversation =
      await this.conversationRepository.save(conversation);

    // Emit socket events
    this.chatGateway.server
      .to(`conversation-${conversationId}`)
      .emit('handlingStatusUpdated', {
        conversationId,
        handlingStatus: HandlingStatus.WAITING_FOR_AGENT,
      });
    this.chatGateway.server
      .to(`site-${conversation.siteId}`)
      .emit('conversationActivity', { id: conversationId });

    // Notify agents
    if (conversation.site) {
      const recipientIds = new Set([
        conversation.site.ownerId,
        ...conversation.site.agents.map((a) => a.id),
      ]);
      for (const userId of recipientIds) {
        try {
          await this.notificationService.create({
            recipientId: userId,
            type: NotificationType.AGENT_HANDOFF_REQUEST,
            title: 'Agent Requested',
            message: `${conversation.visitorName && conversation.visitorName !== '[NONE]' ? conversation.visitorName : 'A visitor'} has requested to speak with a human agent.`,
            siteId: conversation.siteId,
            conversationId: conversation.id,
          });
        } catch (error) {
          this.logger.error(
            `Failed to notify user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return savedConversation;
  }

  // ─── Get Active Conversations ──────────────────────────────────────────────

  /**
   * Returns conversation statistics for the requesting user (used by the inbox tabs).
   */
  async getConversationStats(user: JwtUser, siteId?: string) {
    const ownedSites = await this.siteRepository.find({
      where: { ownerId: user.id },
    });

    const assignedSites = await this.siteRepository
      .createQueryBuilder('site')
      .innerJoin('site.agents', 'agent', 'agent.id = :userId', {
        userId: user.id,
      })
      .getMany();

    const ownedSiteIds = ownedSites.map((s) => s.id);
    const assignedSiteIds = assignedSites.map((s) => s.id);
    const allSiteIds = [...new Set([...ownedSiteIds, ...assignedSiteIds])];

    if (user.role !== UserRole.SUPER_ADMIN && allSiteIds.length === 0) {
      return {
        total: 0,
        activeBotCount: 0,
        waitingCount: 0,
        assignedCount: 0,
        closedCount: 0,
      };
    }

    const baseQuery =
      this.conversationRepository.createQueryBuilder('conversation');

    if (user.role === UserRole.SUPER_ADMIN) {
      // Super Admins see stats for ALL conversations. No siteId restriction needed.
    } else if (user.role === UserRole.ADMIN) {
      if (ownedSiteIds.length > 0) {
        baseQuery.andWhere('conversation.siteId IN (:...ownedSiteIds)', {
          ownedSiteIds,
        });
      } else {
        return {
          total: 0,
          activeBotCount: 0,
          waitingCount: 0,
          assignedCount: 0,
          closedCount: 0,
        };
      }
    } else {
      baseQuery
        .andWhere('conversation.siteId IN (:...allSiteIds)', { allSiteIds })
        .andWhere(
          new Brackets((qb) => {
            qb.where('conversation.agentId IS NULL').orWhere(
              'conversation.agentId = :agentId',
              { agentId: user.id },
            );
          }),
        );
    }

    if (siteId) {
      baseQuery.andWhere('conversation.siteId = :siteId', { siteId });
    }

    const [activeBotCount, waitingCount, assignedCount, closedCount] =
      await Promise.all([
        baseQuery
          .clone()
          .andWhere('conversation.status != :closed', {
            closed: ConversationStatus.CLOSED,
          })
          .andWhere('conversation.handlingStatus = :status', {
            status: HandlingStatus.AI_HANDLING,
          })
          .getCount(),
        baseQuery
          .clone()
          .andWhere('conversation.status != :closed', {
            closed: ConversationStatus.CLOSED,
          })
          .andWhere('conversation.handlingStatus = :status', {
            status: HandlingStatus.WAITING_FOR_AGENT,
          })
          .getCount(),
        baseQuery
          .clone()
          .andWhere('conversation.status != :closed', {
            closed: ConversationStatus.CLOSED,
          })
          .andWhere('conversation.handlingStatus = :status', {
            status: HandlingStatus.AGENT_HANDLING,
          })
          .getCount(),
        baseQuery
          .clone()
          .andWhere('conversation.status = :closed', {
            closed: ConversationStatus.CLOSED,
          })
          .getCount(),
      ]);

    const total = activeBotCount + waitingCount + assignedCount;

    return {
      total,
      activeBotCount,
      waitingCount,
      assignedCount,
      closedCount,
    };
  }

  /**
   * Returns OPEN conversations visible to the requesting user.
   *
   * - SuperAdmin/Admin: all conversations on sites they OWN
   * - Agent: conversations on assigned sites where agentId IS NULL (unclaimed)
   *          OR agentId = themselves (their own chats)
   */
  async getActiveConversations(
    query: PaginateQuery,
    user: JwtUser,
  ): Promise<Paginated<Conversation>> {
    const ownedSites = await this.siteRepository.find({
      where: { ownerId: user.id },
    });

    const assignedSites = await this.siteRepository
      .createQueryBuilder('site')
      .innerJoin('site.agents', 'agent', 'agent.id = :userId', {
        userId: user.id,
      })
      .getMany();

    const ownedSiteIds = ownedSites.map((s) => s.id);
    const assignedSiteIds = assignedSites.map((s) => s.id);
    const allSiteIds = [...new Set([...ownedSiteIds, ...assignedSiteIds])];

    if (user.role !== UserRole.SUPER_ADMIN && allSiteIds.length === 0) {
      return this.emptyPaginated(query);
    }

    const queryBuilder = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.site', 'site')
      .leftJoinAndSelect('conversation.agent', 'agent');

    // Only exclude CLOSED if the client hasn't explicitly asked for a status filter
    if (!query.filter || !query.filter.status) {
      queryBuilder.where('conversation.status != :closed', {
        closed: ConversationStatus.CLOSED,
      });
    } else {
      queryBuilder.where('1=1'); // Dummy where so subsequent andWhere works properly
    }

    if (user.role === UserRole.SUPER_ADMIN) {
      // Super Admins see ALL conversations across the platform. No siteId restriction needed.
    } else if (user.role === UserRole.ADMIN) {
      // Admins see ALL conversations on their owned sites
      if (ownedSiteIds.length > 0) {
        queryBuilder.andWhere('conversation.siteId IN (:...ownedSiteIds)', {
          ownedSiteIds,
        });
      } else {
        return this.emptyPaginated(query);
      }
    } else {
      // Agents see only unclaimed or their own conversations on assigned sites
      queryBuilder
        .andWhere('conversation.siteId IN (:...allSiteIds)', { allSiteIds })
        .andWhere(
          new Brackets((qb) => {
            qb.where('conversation.agentId IS NULL').orWhere(
              'conversation.agentId = :agentId',
              { agentId: user.id },
            );
          }),
        );
    }

    const result = await paginate(query, queryBuilder, {
      sortableColumns: [
        'id',
        'createdAt',
        'updatedAt',
        'status',
        'siteId',
        'lastActivityAt',
      ],
      defaultSortBy: [['lastActivityAt', 'DESC']],
      filterableColumns: {
        siteId: [FilterOperator.EQ],
        status: [FilterOperator.EQ, FilterSuffix.NOT],
        handlingStatus: [FilterOperator.EQ],
        agentId: [FilterOperator.EQ, FilterOperator.IN, FilterOperator.NULL],
        lastActivityAt: [
          FilterOperator.GTE,
          FilterOperator.LTE,
          FilterOperator.BTW,
        ],
      },
    });

    // Attach the latest message per conversation (one query) so the inbox can
    // render a preview without an extra round-trip per conversation.
    const latestMap = await this.getLatestMessagesByConversations(
      result.data.map((c) => c.id),
    );

    return {
      ...result,
      data: result.data.map((c) => ({
        ...c,
        latestMessage: latestMap.get(c.id) ?? null,
      })),
    };
  }

  // ─── Assign Agent ──────────────────────────────────────────────────────────

  async assignAgentToConversation(
    conversationId: string,
    agentUser: JwtUser,
  ): Promise<{ conversation: Conversation; isNewAssignment: boolean }> {
    const conversation = await this.conversationRepository.findOne({
      where: { id: conversationId },
      relations: { site: true },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    if (
      agentUser.role === UserRole.SUPER_ADMIN ||
      agentUser.role === UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Admins and Super Admins can only view conversations, they cannot take over.',
      );
    }

    // Block if another agent already owns it
    if (conversation.agentId && conversation.agentId !== agentUser.id) {
      throw new UnauthorizedException(
        'This conversation is already being handled by another agent',
      );
    }

    let isNewAssignment = false;
    if (!conversation.agentId) {
      conversation.agentId = agentUser.id;
      conversation.handlingStatus = HandlingStatus.AGENT_HANDLING;
      conversation.isAiActive = false; // Flip conversation-level AI flag off
      await this.conversationRepository.save(conversation);
      isNewAssignment = true;
      this.logger.log(
        `Agent ${agentUser.email} assigned to conversation ${conversationId}`,
      );

      // Pause inactivity timer if site is configured to pause for agent chats
      if (conversation.site?.pauseTimerForAgentChats) {
        this.chatTimeoutService.pauseTimer(conversation.id);
      }

      // Notify the whole site room so other agents' inboxes refresh
      this.chatGateway.notifyConversationAssigned(
        conversation.id,
        conversation.siteId,
      );

      // Save system message
      const agent = await this.userRepository.findOne({
        where: { id: agentUser.id },
      });
      const agentName = agent ? agent.name : 'An agent';
      const joinMsg = await this.saveMessage(
        conversationId,
        `Agent ${agentName} has joined the conversation.`,
        SenderType.SYSTEM,
      );

      // Broadcast system message to the conversation room
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('newMessage', {
          id: joinMsg.id,
          conversationId,
          content: joinMsg.content,
          senderType: joinMsg.senderType,
          createdAt: joinMsg.createdAt,
        });

      // Notify admin dashboard to sync its AI toggle UI
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('aiToggled', {
          conversationId,
          isAiActive: false,
        });
      this.chatGateway.server
        .to(`site-${conversation.siteId}`)
        .emit('aiToggled', {
          conversationId,
          isAiActive: false,
        });
    }

    return { conversation, isNewAssignment };
  }

  // ─── Get Single Conversation ───────────────────────────────────────────────

  async getConversationById(id: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
      relations: { site: true, agent: true },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  /**
   * Fetch a conversation enforcing visibility for the requesting user.
   * Agents may only view unclaimed conversations or their own; a conversation
   * already claimed by another agent is blocked (403). Admins/superadmins see
   * everything.
   */
  async getConversationForUser(
    id: string,
    user: JwtUser,
  ): Promise<Conversation> {
    const conversation = await this.getConversationById(id);

    const isAdminOrAbove =
      user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN;

    if (
      !isAdminOrAbove &&
      conversation.agentId &&
      conversation.agentId !== user.id
    ) {
      throw new ForbiddenException(
        'This chat is being handled by another agent',
      );
    }

    return conversation;
  }

  // ─── Message Handling ──────────────────────────────────────────────────────

  async processIncomingMessage(
    conversationId: string,
    content: string,
    senderType: SenderType,
    agentId?: string,
  ): Promise<{ savedMessage: ChatMessage; conversation: Conversation }> {
    const savedMessage = await this.saveMessage(
      conversationId,
      content,
      senderType,
      agentId,
    );

    const conversation = await this.getConversationById(conversationId);

    // Notify the site room so the conversation list re-sorts
    this.chatGateway.server
      .to(`site-${conversation.siteId}`)
      .emit('conversationActivity', { id: conversationId });

    return { savedMessage, conversation };
  }

  async setConversationStatus(
    id: string,
    status: ConversationStatus,
    reason?: ClosedReason,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ForbiddenException('Conversation is already closed');
    }

    conversation.status = status;
    if (status === ConversationStatus.CLOSED) {
      if (reason) conversation.closedReason = reason;
      this.chatTimeoutService.cancelTimer(id);
    }
    conversation.lastActivityAt = new Date();

    return this.conversationRepository.save(conversation);
  }

  async updateConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
  ): Promise<Conversation> {
    return this.updateStatusAndNotify(
      id,
      dto.status,
      dto.reason || ClosedReason.AGENT,
    );
  }

  async updatePublicConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
  ): Promise<Conversation> {
    return this.updateStatusAndNotify(
      id,
      dto.status,
      dto.reason || ClosedReason.VISITOR,
    );
  }

  async getPublicConversationStatus(id: string) {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
      select: {
        id: true,
        status: true,
        handlingStatus: true,
        closedReason: true,
      },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    return {
      conversationId: conversation.id,
      status: conversation.status,
      handlingStatus: conversation.handlingStatus,
      closedReason: conversation.closedReason,
    };
  }

  private async updateStatusAndNotify(
    id: string,
    status: ConversationStatus,
    reason?: ClosedReason,
  ): Promise<Conversation> {
    if (status === ConversationStatus.CLOSED) {
      const closedConv = await this.closeConversation(id, reason);
      this.chatGateway.emitConversationStatusChanged(id, closedConv.status);
      return closedConv;
    }

    const conversation = await this.setConversationStatus(id, status, reason);
    this.chatGateway.emitConversationStatusChanged(id, conversation.status);

    return conversation;
  }

  // ─── Messages ─────────────────────────────────────────────────────────────

  async getMessagesForConversation(
    conversationId: string,
    cursor?: string,
    limitStr?: string,
  ): Promise<ChatMessageDto[]> {
    const parsedLimit = limitStr ? parseInt(limitStr, 10) : 50;
    const cursorDate = cursor ? new Date(cursor) : undefined;

    const messages = await this.chatMessageRepository.find({
      where: cursorDate
        ? { conversationId, createdAt: LessThan(cursorDate) }
        : { conversationId },
      relations: { agent: true },
      order: { createdAt: 'DESC' },
      take: parsedLimit,
    });

    return messages.reverse().map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      senderType: message.senderType,
      agentId: message.agentId,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
      senderName: message.agent?.name ?? null,
    }));
  }

  async getConversationMessagesForUser(
    conversationId: string,
    user: JwtUser,
    cursor?: string,
    limitStr?: string,
  ): Promise<ChatMessageDto[]> {
    // Re-use existing authorization logic; this throws if access is denied
    await this.getConversationForUser(conversationId, user);

    return this.getMessagesForConversation(conversationId, cursor, limitStr);
  }

  async saveMessage(
    conversationId: string,
    content: string,
    senderType: SenderType,
    agentId?: string,
  ): Promise<ChatMessage> {
    const conversation = await this.getConversationById(conversationId);
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ForbiddenException('Conversation is closed');
    }

    const message = this.chatMessageRepository.create({
      conversationId,
      content,
      senderType,
      agentId: agentId ?? null,
    });

    console.log(`Message::: ${JSON.stringify(message)}`);
    const savedMessage = await this.chatMessageRepository.save(message);

    if (agentId) {
      const messageWithAgent = await this.chatMessageRepository.findOne({
        where: { id: savedMessage.id },
        relations: { agent: true },
      });
      if (messageWithAgent) {
        savedMessage.agent = messageWithAgent.agent;
      }
    }

    // Update lastActivityAt
    await this.conversationRepository.update(conversationId, {
      lastActivityAt: new Date(),
    });

    // Reset inactivity timer according to senderType and site settings
    if (senderType === SenderType.VISITOR || senderType === SenderType.AGENT) {
      this.chatTimeoutService.resetTimer(conversationId, conversation.site);
    } else if (senderType === SenderType.AI) {
      if (conversation.site?.resetTimerOnBotResponse) {
        this.chatTimeoutService.resetTimer(conversationId, conversation.site);
      }
    }
    // Note: SYSTEM messages (e.g. warning messages) intentionally do NOT reset the timer

    // Emit ephemeral toast to agent (NOT persisted to DB)
    if (senderType === SenderType.VISITOR && conversation.agentId) {
      this.chatGateway.emitChatToastToAgent(conversation.agentId, {
        conversationId: conversation.id,
        title: `New message from ${conversation.visitorName}`,
        visitorName: conversation.visitorName,
      });
    }

    return savedMessage;
  }

  async markConversationDelivered(
    conversationId: string,
    receiverType: SenderType,
  ): Promise<void> {
    await this.chatMessageRepository.update(
      {
        conversationId,
        senderType:
          receiverType === SenderType.VISITOR
            ? SenderType.AGENT
            : SenderType.VISITOR,
        status: MessageStatus.SENT,
      },
      { status: MessageStatus.DELIVERED },
    );
  }

  async markConversationRead(
    conversationId: string,
    readerType: SenderType,
  ): Promise<void> {
    await this.chatMessageRepository.update(
      {
        conversationId,
        senderType:
          readerType === SenderType.VISITOR
            ? SenderType.AGENT
            : SenderType.VISITOR,
        status: In([MessageStatus.SENT, MessageStatus.DELIVERED]),
      },
      { status: MessageStatus.READ },
    );
  }

  // ─── Close / Delete ────────────────────────────────────────────────────────

  async closeConversation(
    id: string,
    reason: ClosedReason = ClosedReason.VISITOR,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
      relations: { site: { owner: true } },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    await this.conversationRepository.update(id, {
      status: ConversationStatus.CLOSED,
      closedReason: reason,
    });

    this.chatTimeoutService.cancelTimer(id);

    this.chatGateway.notifyConversationClosed(id, conversation.siteId);

    if (conversation.agentId) {
      try {
        await this.notificationService.create({
          recipientId: conversation.agentId,
          type: NotificationType.CONVERSATION_CLOSED,
          title: 'Conversation Closed',
          message: `Conversation with ${conversation.visitorName} has been closed.`,
          siteId: conversation.siteId,
          conversationId: conversation.id,
        });
      } catch (error) {
        this.logger.error(
          `Failed to notify agent ${conversation.agentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Only send summary & transcript emails if the conversation was closed normally (not just cleared/reset by visitor)
    if (
      reason !== ClosedReason.CLEARED &&
      conversation.site &&
      conversation.site.owner
    ) {
      const messageCount = await this.chatMessageRepository.count({
        where: { conversationId: conversation.id },
      });

      let finalSummary = conversation.summary;

      if (!finalSummary && messageCount > 0) {
        const messages = await this.chatMessageRepository.find({
          where: { conversationId: conversation.id },
          order: { createdAt: 'ASC' },
        });

        const messagesToSummarize = messages
          .map((m) => ({
            role:
              m.senderType === SenderType.VISITOR
                ? 'user'
                : m.senderType === SenderType.AI
                  ? 'assistant'
                  : 'system',
            content: m.content || '',
          }))
          .filter((m) => m.role !== 'system');

        if (messagesToSummarize.length > 0) {
          const summaryPrompt = `Summarise the following conversation concisely:\n${JSON.stringify(messagesToSummarize)}`;
          try {
            const aiResponse = await this.aiService.invoke({
              messages: [{ role: 'user', content: summaryPrompt }],
            });
            finalSummary = aiResponse.content;

            await this.conversationRepository.update(conversation.id, {
              summary: finalSummary,
              summarizedMessageCount: messageCount,
            });
          } catch (err) {
            this.logger.error(
              'Failed to generate final summary: ' +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
      }

      void this.emailQueueService.enqueueConversationSummaryEmail({
        to: conversation.site.owner.email,
        adminName: conversation.site.owner.name || 'Admin',
        siteName: conversation.site.name,
        conversationId: conversation.id,
        visitorName: conversation.visitorName || undefined,
        visitorEmail: conversation.visitorEmail || undefined,
        messageCount,
        startedAt: conversation.createdAt.toISOString(),
        closedAt: new Date().toISOString(),
        summaryText: finalSummary || 'No summary available.',
      });

      let targetEmail = conversation.visitorEmail;
      let targetName = conversation.visitorName;

      if (messageCount > 0) {
        const rawMessages = await this.chatMessageRepository.find({
          where: { conversationId: conversation.id },
          order: { createdAt: 'ASC' },
          relations: { agent: true },
        });

        const fullChatContent = rawMessages.map((m) => m.content).join('\n');
        const bookingCode = latestActiveBookingCode(fullChatContent);

        if (bookingCode) {
          const booking = await this.bookingRepository.findOne({
            where: { code: bookingCode },
          });
          if (booking && booking.customerEmail) {
            targetEmail = booking.customerEmail;
            targetName = booking.customerName || targetName;
          }
        }

        if (targetEmail) {
          const transcriptMessages = rawMessages
            .filter((m) => m.senderType !== SenderType.SYSTEM)
            .map((m) => {
              let cleanContent = (m.content || '')
                .replace(/<booking-code>.*?<\/booking-code>/gs, '')
                .replace(/<booking-cancelled>.*?<\/booking-cancelled>/gs, '')
                .replace(/<chips>.*?<\/chips>/gs, '')
                .trim();

              const slashCmdMatch = cleanContent.match(
                /^\/([\w-]+)(?:\s+((?:(?!\s*::).)*))?(?:\s*::\s*(.*))?$/s,
              );
              if (slashCmdMatch) {
                const command = slashCmdMatch[1];
                const payload = slashCmdMatch[2];
                const textAfter = slashCmdMatch[3];

                if (command === 'confirm-booking' && payload) {
                  try {
                    const data = JSON.parse(payload) as Record<string, unknown>;
                    let formatted = `**[Booking Confirmed]**`;
                    if (typeof data.date === 'string')
                      formatted += `\n- Date: ${data.date}`;
                    if (typeof data.timeSlot === 'string')
                      formatted += `\n- Time: ${data.timeSlot}`;
                    if (typeof data.customerName === 'string')
                      formatted += `\n- Name: ${data.customerName}`;
                    if (typeof data.phone === 'string')
                      formatted += `\n- Phone: ${data.phone}`;
                    cleanContent = formatted;
                  } catch {
                    cleanContent = `**[Booking Confirmed]**`;
                  }
                } else if (textAfter) {
                  cleanContent = textAfter;
                } else {
                  cleanContent = '';
                }
              }

              return {
                displayName:
                  m.senderType === SenderType.VISITOR
                    ? 'You'
                    : m.senderType === SenderType.AI
                      ? 'Bot'
                      : m.agent?.name || 'Agent',
                content: cleanContent,
                timestamp: m.createdAt.toISOString(),
              };
            })
            .filter((m) => m.content.length > 0);

          if (transcriptMessages.length > 0) {
            void this.emailQueueService.enqueueChatTranscriptEmail({
              to: targetEmail,
              visitorName: targetName || 'Visitor',
              siteName: conversation.site.name || 'Support Chat',
              messages: transcriptMessages,
              startedAt: conversation.createdAt.toISOString(),
              closedAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    return this.getConversationById(id);
  }

  async deleteConversation(id: string): Promise<Conversation> {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    await this.conversationRepository.delete(id);
    this.chatGateway.notifyConversationClosed(id, conversation.siteId);
    return conversation;
  }

  /**
   * Toggles the conversation-level AI active flag.
   * Called by ChatGateway.handleJoinConversation() when an agent takes over.
   * Both site.isAiActive AND conversation.isAiActive must be true for the
   * AgentService to invoke the LangGraph workflow.
   */
  async setConversationAiActive(
    conversationId: string,
    isAiActive: boolean,
  ): Promise<void> {
    await this.conversationRepository.update(conversationId, { isAiActive });
    this.logger.log(
      `Conversation ${conversationId} isAiActive set to ${isAiActive}`,
    );
  }

  async getIdleOpenConversations(cutoffDate: Date): Promise<Conversation[]> {
    return this.conversationRepository.find({
      where: {
        status: ConversationStatus.OPEN,
        lastActivityAt: LessThan(cutoffDate),
      },
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private validateMessagePayload(payload: ChatMessagePayload): string {
    const message =
      typeof payload === 'string'
        ? payload
        : this.extractMessageFromObject(payload);

    if (typeof message !== 'string') {
      throw new WsException('Message must be a string');
    }

    const normalizedMessage = message.trim();

    if (!normalizedMessage) {
      throw new WsException('Message must not be empty');
    }

    if (normalizedMessage.length > MAX_MESSAGE_LENGTH) {
      throw new WsException(
        `Message must not exceed ${MAX_MESSAGE_LENGTH} characters`,
      );
    }

    return normalizedMessage;
  }

  private extractMessageFromObject(payload: ChatMessagePayload): string | null {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !Object.hasOwn(payload, 'message')
    ) {
      return null;
    }

    return payload.message;
  }

  /**
   * Fetches the latest message for each conversation in one query
   * (DISTINCT ON conversationId, ordered by createdAt DESC).
   */
  private async getLatestMessagesByConversations(
    conversationIds: string[],
  ): Promise<
    Map<string, { content: string; senderType: string; createdAt: string }>
  > {
    const map = new Map<
      string,
      { content: string; senderType: string; createdAt: string }
    >();
    if (conversationIds.length === 0) return map;

    const rows = await this.chatMessageRepository
      .createQueryBuilder('m')
      .select('m.conversationId', 'conversationId')
      .addSelect('m.content', 'content')
      .addSelect('m.senderType', 'senderType')
      .addSelect('m.createdAt', 'createdAt')
      .distinctOn(['m.conversationId'])
      .where('m.conversationId IN (:...ids)', { ids: conversationIds })
      .orderBy('m.conversationId', 'ASC')
      .addOrderBy('m.createdAt', 'DESC')
      .getRawMany<{
        conversationId: string;
        content: string;
        senderType: string;
        createdAt: string | Date;
      }>();

    for (const row of rows) {
      map.set(row.conversationId, {
        content: row.content,
        senderType: row.senderType,
        createdAt: new Date(row.createdAt).toISOString(),
      });
    }
    return map;
  }

  private emptyPaginated(query: PaginateQuery): Paginated<Conversation> {
    return {
      data: [],
      meta: {
        itemsPerPage: query.limit ?? 20,
        totalItems: 0,
        currentPage: query.page ?? 1,
        totalPages: 0,
        sortBy: [],
        searchBy: [],
        search: '',
        select: [],
        filter: {},
        cursor: undefined,
      },
      links: { first: '', previous: '', current: '', next: '', last: '' },
    };
  }

  // ─── Attachments ─────────────────────────────────────────────────────────

  async uploadAttachment(file: Express.Multer.File): Promise<string> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'chat_attachments' },
        (error, result: UploadApiResponse | undefined) => {
          if (error) {
            reject(new Error(error.message || 'Cloudinary upload failed'));
          } else if (result) {
            resolve(result.secure_url);
          } else {
            reject(new Error('Cloudinary upload failed'));
          }
        },
      );
      uploadStream.end(file.buffer);
    });
  }
}
