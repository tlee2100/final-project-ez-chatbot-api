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
import { ChatGateway, SocketData, ChatMessagePayload } from './chat.gateway';
import { GraphService } from './graph.service';
import { CreateConversationResponseDto } from './dto/create-conversation-response.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';

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
  private inactiveConversationTimer: NodeJS.Timeout;
  private readonly inactiveConversationMs = 15 * 60 * 1000;
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
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => GraphService))
    private readonly graphService: GraphService,
  ) {}

  onModuleInit() {
    this.inactiveConversationTimer = setInterval(() => {
      void this.closeInactiveConversations();
    }, 60 * 1000);
    this.inactiveConversationTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.inactiveConversationTimer) {
      clearInterval(this.inactiveConversationTimer);
    }
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
      this.logger.log(
        `Visitor connected for conversation ${visitor.conversationId}`,
      );
      void client.join(`conversation-${visitor.conversationId}`);
      this.trackConversationPresence(client, visitor.conversationId);

      const receiverType = SenderType.VISITOR;
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

      client.emit('connected', { message: `Connected as visitor` });
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
          .handleVisitorMessage(payload.conversationId, conversation.siteId)
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
          message: `${dto.visitorName} has started a new conversation. The AI is currently handling it — you may take over anytime.`,
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
            type: NotificationType.CONVERSATION_WAITING,
            title: 'Agent Requested',
            message: `${conversation.visitorName} has requested to speak with a human agent.`,
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
    conversation.lastActivityAt = new Date();

    return this.conversationRepository.save(conversation);
  }

  async updateConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
  ): Promise<Conversation> {
    return this.updateStatusAndNotify(id, dto.status);
  }

  async updatePublicConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
  ): Promise<Conversation> {
    return this.updateStatusAndNotify(id, dto.status);
  }

  async getPublicConversationStatus(id: string) {
    const conversation = await this.conversationRepository.findOne({
      where: { id },
      select: { id: true, status: true, handlingStatus: true },
    });

    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    return {
      conversationId: conversation.id,
      status: conversation.status,
      handlingStatus: conversation.handlingStatus,
    };
  }

  private async updateStatusAndNotify(
    id: string,
    status: ConversationStatus,
  ): Promise<Conversation> {
    const conversation = await this.setConversationStatus(id, status);
    this.chatGateway.emitConversationStatusChanged(id, conversation.status);

    if (conversation.status === ConversationStatus.CLOSED) {
      this.chatGateway.notifyConversationClosed(id, conversation.siteId);
    }

    return conversation;
  }

  async closeInactiveConversations(): Promise<number> {
    const conversations = await this.conversationRepository.find({
      where: {
        status: ConversationStatus.OPEN,
        lastActivityAt: LessThan(
          new Date(Date.now() - this.inactiveConversationMs),
        ),
      },
      select: { id: true, siteId: true },
    });
    const conversationIds = conversations.map((c) => c.id);

    if (conversationIds.length === 0) {
      return 0;
    }

    const result = await this.conversationRepository.update(
      { id: In(conversationIds) },
      { status: ConversationStatus.CLOSED },
    );

    for (const listener of this.conversationsClosedListeners) {
      listener(conversationIds);
    }

    return result.affected ?? 0;
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

  async closeConversation(id: string): Promise<Conversation> {
    const conversation = await this.getConversationById(id);
    await this.conversationRepository.update(id, {
      status: ConversationStatus.CLOSED,
    });

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
}
