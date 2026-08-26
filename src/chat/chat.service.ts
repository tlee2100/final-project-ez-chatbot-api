import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  forwardRef,
  Inject,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
  FeedbackRating,
} from './entities/chat-message.entity';
import { User } from '../user/entities/user.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { CloseConversationResponseDto } from './dto/close-conversation-response.dto';
import {
  SubmitMessageFeedbackDto,
  MessageFeedbackResponseDto,
} from './dto/submit-message-feedback.dto';
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
import { BookingService } from '../booking/booking.service';
import { latestActiveBookingCode } from './booking-cancellation.utils';
import { AI_MODERATION_SERVICE } from '../security/interfaces/moderation.interface';
import type { IAIModerationService as IAIModerationServiceType } from '../security/interfaces/moderation.interface';
import type { RawPageContext } from './interfaces/page-context.interface';

type ChatMessageDto = Pick<
  ChatMessage,
  | 'id'
  | 'conversationId'
  | 'senderType'
  | 'agentId'
  | 'content'
  | 'locale'
  | 'components'
  | 'status'
  | 'createdAt'
  | 'feedbackRating'
  | 'feedbackAt'
> & {
  senderName?: string | null;
};
const MAX_MESSAGE_LENGTH = 1000;

const pageContextFromPayload = (
  payload: RawPageContext,
): RawPageContext | undefined => {
  if (
    payload.pageUrl === undefined &&
    payload.pageTitle === undefined &&
    payload.pageContent === undefined
  ) {
    return undefined;
  }

  return {
    pageUrl: payload.pageUrl,
    pageTitle: payload.pageTitle,
    pageContent: payload.pageContent,
  };
};

/** In-memory state for WS rate limiting (SEC-005) */
interface WsRateLimitEntry {
  count: number;
  resetAt: number;
}

@Injectable()
export class ChatService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(ChatService.name);
  private readonly conversationsClosedListeners = new Set<
    (ids: string[]) => void
  >();

  private readonly conversationPresence = new Map<
    string,
    { agent: Set<string>; visitor: Set<string> }
  >();

  /**
   * SEC-005 — WebSocket Rate Limiter
   * Key = `${siteId}-${clientIp}`. Enforces WS_LIMIT requests per WS_WINDOW_MS.
   * Entries are lazily cleaned up on the next request from the same key.
   */
  private readonly wsRateLimitMap = new Map<string, WsRateLimitEntry>();
  private readonly WS_LIMIT = 30; // max messages per window
  private readonly WS_WINDOW_MS = 60_000; // 1 minute
  /** Active IP session tracking: `${siteId}-${clientIp}` -> Set<conversationId> */
  private readonly ipActiveSessionsMap = new Map<string, Set<string>>();

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly chatMessageRepository: Repository<ChatMessage>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Inject(forwardRef(() => BookingService))
    private readonly bookingService: BookingService,
    private readonly notificationService: NotificationService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly chatGateway: ChatGateway,
    @Inject(forwardRef(() => GraphService))
    private readonly graphService: GraphService,
    @Inject(forwardRef(() => ChatTimeoutService))
    private readonly chatTimeoutService: ChatTimeoutService,
    private readonly emailQueueService: EmailQueueService,
    private readonly aiService: AiService,
    @Inject(AI_MODERATION_SERVICE)
    private readonly moderationService: IAIModerationServiceType,
    private readonly jwtService: JwtService,
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
        void client.join(`site-settings-${visitor.siteId}`);
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
    const socketData = client.data as SocketData;

    // Authenticated user (agent/admin): verify site ownership/access
    if (socketData.user) {
      try {
        await this.assertConversationSiteAccess(
          payload.conversationId,
          socketData.user,
        );
      } catch {
        client.emit('subscribeError', {
          message: 'You do not have access to this conversation',
          code: 403,
        });
        return;
      }
    }

    // Visitor: verify they are only subscribing to their own conversation
    if (
      socketData.visitor &&
      socketData.visitor.conversationId &&
      socketData.visitor.conversationId !== payload.conversationId
    ) {
      client.emit('subscribeError', {
        message: 'Unauthorized conversation',
        code: 403,
      });
      return;
    }

    void client.join(`conversation-${payload.conversationId}`);
    this.trackConversationPresence(client, payload.conversationId);

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
    } & RawPageContext,
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

      // ── SEC-005: WebSocket Rate Limit ──────────────────────────────────────
      const siteIdForLimit = visitor.siteId ?? 'unknown';
      const clientIp =
        (client.handshake.headers['x-forwarded-for'] as string | undefined)
          ?.split(',')[0]
          ?.trim() ??
        client.handshake.address ??
        'unknown';
      const rlKey = `${siteIdForLimit}-${clientIp}`;
      const now = Date.now();
      const entry = this.wsRateLimitMap.get(rlKey);

      if (entry && now < entry.resetAt) {
        if (entry.count >= this.WS_LIMIT) {
          this.logger.warn(`WS rate limit exceeded — key: ${rlKey}`);
          client.emit('messageError', {
            message: 'Rate limit exceeded. Please slow down.',
            code: 429,
          });
          return;
        }
        entry.count += 1;
      } else {
        // New window or expired entry
        this.wsRateLimitMap.set(rlKey, {
          count: 1,
          resetAt: now + this.WS_WINDOW_MS,
        });
      }

      // ── SEC-005: Max Messages Per Session Enforcement ──────────────────────
      if (!payload.conversationId.startsWith('admin-test-')) {
        const conversation = await this.conversationRepository.findOne({
          where: { id: payload.conversationId },
          relations: { site: true },
        });
        if (conversation?.site?.maxMessagesPerSession) {
          const msgCount = await this.chatMessageRepository.count({
            where: {
              conversationId: payload.conversationId,
              senderType: SenderType.VISITOR,
            },
          });
          if (msgCount >= conversation.site.maxMessagesPerSession) {
            this.logger.warn(
              `Max messages per session cap reached (${msgCount}/${conversation.site.maxMessagesPerSession}) for conv ${payload.conversationId}`,
            );
            client.emit('messageError', {
              message:
                'Session message limit reached. Please start a new conversation.',
              code: 429,
            });
            return;
          }
        }
      }

      // ── SEC-006: Content Moderation ────────────────────────────────────────
      const isSafe = await this.moderationService.isSafe(payload.content);
      if (!isSafe) {
        this.logger.warn(
          `Message blocked by moderation for conversation ${payload.conversationId}`,
        );
        client.emit('messageError', {
          message:
            'Your message was blocked because it violates our content policy.',
          code: 403,
        });
        return;
      }
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
          pageContextFromPayload(payload),
        )
        .catch((err: unknown) =>
          this.logger.error(
            `AI test stream error: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      return;
    }

    try {
      this.logger.log(
        `💬 [Chat Incoming Message] [Conv: ${payload.conversationId}] [Sender: ${payload.senderType}] Content: "${payload.content}"`,
      );

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

      // Automatically trigger AI if the visitor sent the message
      if (payload.senderType === SenderType.VISITOR) {
        // Fetch full site to check AI status and agents
        const fullSite = await this.siteRepository.findOne({
          where: { id: conversation.siteId },
          relations: { agents: true },
        });

        if (
          fullSite &&
          !fullSite.isAiActive &&
          conversation.handlingStatus === HandlingStatus.AI_HANDLING
        ) {
          // If AI is disabled but conversation thinks it's AI_HANDLING, fix it so frontend stops typing
          await this.escalateToAgent(payload.conversationId);
        } else if (fullSite && fullSite.isAiActive) {
          // Run in background so we don't block the WebSocket response
          this.graphService
            .handleVisitorMessage(
              payload.conversationId,
              conversation.siteId,
              undefined,
              async (text: string) => {
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
              },
              undefined,
              pageContextFromPayload(payload),
            )
            .catch((err: unknown) => {
              const errorMsg =
                'AI service is temporarily unavailable. Please try again later or request support from an agent.';
              this.logger.error(
                `AI stream error: ${err instanceof Error ? err.message : String(err)}`,
              );
              this.chatGateway.server
                .to(`conversation-${payload.conversationId}`)
                .emit('messageError', {
                  conversationId: payload.conversationId,
                  message: errorMsg,
                });
              this.chatGateway.server
                .to(`conversation-${payload.conversationId}`)
                .emit('aiMessageComplete', {
                  conversationId: payload.conversationId,
                });
            });
        }
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to send message';
      client.emit('messageError', { message });
    }
  }

  handleTyping(client: Socket, payload: { conversationId: string }): void {
    if (!payload?.conversationId) return;
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
    if (!payload?.conversationId) return;
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
    clientIp?: string,
  ): Promise<CreateConversationResponseDto> {
    const site = await this.siteRepository.findOne({
      where: { id: dto.siteId },
      relations: { agents: true },
    });
    if (!site) {
      throw new NotFoundException(`Site ${dto.siteId} not found`);
    }
    if (!site.enabled) {
      throw new ForbiddenException(
        'Chat widget is currently disabled for this site',
      );
    }

    // ── SEC-005: Max Sessions Per IP Enforcement ────────────────────────────
    if (clientIp && site.maxSessionsPerIp) {
      const rlKey = `${dto.siteId}-${clientIp}`;
      const sessions = this.ipActiveSessionsMap.get(rlKey) || new Set<string>();
      if (sessions.size >= site.maxSessionsPerIp) {
        throw new HttpException(
          'Maximum active chat sessions reached for your IP address. Please continue existing conversation or try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const result = await this.conversationRepository.manager.transaction(
      async (transactionalEntityManager) => {
        const conversation = transactionalEntityManager.create(Conversation, {
          siteId: dto.siteId,
          visitorName: dto.visitorName?.trim() || 'Guest',
          visitorEmail: dto.visitorEmail?.trim() || null,
          status: ConversationStatus.OPEN,
          handlingStatus: site.isAiActive
            ? HandlingStatus.AI_HANDLING
            : HandlingStatus.WAITING_FOR_AGENT,
          lastActivityAt: new Date(),
          isAiActive: site.isAiActive,
          timezone: dto.timezone ?? null,
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

        const visitorToken = await this.jwtService.signAsync(
          {
            sub: savedConversation.id,
            conversationId: savedConversation.id,
            siteId: savedConversation.siteId,
            type: 'visitor',
          },
          { expiresIn: '7d' },
        );

        return {
          conversationId: savedConversation.id,
          siteId: savedConversation.siteId,
          visitorName: savedConversation.visitorName,
          visitorEmail: savedConversation.visitorEmail,
          status: savedConversation.status,
          handlingStatus: savedConversation.handlingStatus,
          visitorToken,
        };
      },
    );

    if (clientIp) {
      const rlKey = `${dto.siteId}-${clientIp}`;
      const sessions = this.ipActiveSessionsMap.get(rlKey) || new Set<string>();
      sessions.add(result.conversationId);
      this.ipActiveSessionsMap.set(rlKey, sessions);
    }

    this.logger.log(
      `New conversation ${result.conversationId} created for site ${dto.siteId}`,
    );

    // Schedule inactivity timeout & warning timers for the new conversation
    void this.chatTimeoutService.scheduleTimers(
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
    void this.chatTimeoutService.scheduleTimers(
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

    if (
      conversation.site &&
      !conversation.site.humanHandoff &&
      conversation.site.isAiActive
    ) {
      throw new ForbiddenException('Human handoff is disabled for this site');
    }

    if (conversation.handlingStatus === HandlingStatus.AGENT_HANDLING) {
      return conversation; // Already handled
    }

    conversation.handlingStatus = HandlingStatus.WAITING_FOR_AGENT;
    conversation.isAiActive = false;
    const savedConversation =
      await this.conversationRepository.save(conversation);

    // Save and broadcast system handoff message
    const handoffMsg =
      'An agent has been notified and will be with you shortly.';
    const savedMsg = await this.saveMessage(
      conversationId,
      handoffMsg,
      SenderType.SYSTEM,
    );

    this.chatGateway.server
      .to(`conversation-${conversationId}`)
      .emit('newMessage', {
        id: savedMsg.id,
        conversationId,
        content: savedMsg.content,
        senderType: 'SYSTEM',
        createdAt: savedMsg.createdAt,
      });

    // Emit socket events
    this.chatGateway.server
      .to(`conversation-${conversationId}`)
      .emit('handlingStatusUpdated', {
        conversationId,
        handlingStatus: HandlingStatus.WAITING_FOR_AGENT,
      });
    this.chatGateway.server
      .to(`conversation-${conversationId}`)
      .emit('aiToggled', {
        conversationId,
        isAiActive: false,
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

    const total = activeBotCount + waitingCount + assignedCount + closedCount;

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
      .leftJoinAndSelect('conversation.agent', 'agent')
      .where('1=1');

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
    if (
      agentUser.role === UserRole.SUPER_ADMIN ||
      agentUser.role === UserRole.ADMIN
    ) {
      throw new ForbiddenException(
        'Admins and Super Admins can only view conversations, they cannot take over.',
      );
    }

    const conversation = await this.assertConversationSiteAccess(
      conversationId,
      agentUser,
    );

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

      // Broadcast handling status update to conversation room
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('handlingStatusUpdated', {
          conversationId,
          handlingStatus: HandlingStatus.AGENT_HANDLING,
        });

      // Notify admin dashboard to sync its AI toggle UI
      this.chatGateway.server
        .to(`conversation-${conversationId}`)
        .emit('aiToggled', {
          conversationId,
          isAiActive: false,
          handlingStatus: HandlingStatus.AGENT_HANDLING,
        });
      this.chatGateway.server
        .to(`site-${conversation.siteId}`)
        .emit('aiToggled', {
          conversationId,
          isAiActive: false,
          handlingStatus: HandlingStatus.AGENT_HANDLING,
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
   * Asserts that a user has access to a conversation based on their role and organization/site ownership.
   * - SUPER_ADMIN: has unrestricted access to all conversations.
   * - ADMIN: can only access conversations belonging to sites in their organization.
   * - AGENT: can only access conversations belonging to sites they own or are assigned to.
   */
  async assertConversationSiteAccess(
    conversationId: string,
    user: JwtUser,
  ): Promise<Conversation> {
    if (conversationId.startsWith('admin-test-')) {
      return {
        id: conversationId,
        status: ConversationStatus.OPEN,
        handlingStatus: HandlingStatus.AI_HANDLING,
        closedReason: null,
      } as Conversation;
    }

    const conversation = await this.getConversationById(conversationId);

    if (user.role === UserRole.SUPER_ADMIN) {
      return conversation;
    }

    const site = await this.siteRepository.findOne({
      where: { id: conversation.siteId },
      relations: { agents: true },
    });

    if (!site) {
      throw new NotFoundException(
        `Site for conversation ${conversationId} not found`,
      );
    }

    // Every non-super-admin user must belong to the same organization as the site
    if (!user.organizationId || site.organizationId !== user.organizationId) {
      throw new ForbiddenException(
        'You do not have permission to access this conversation',
      );
    }

    if (user.role === UserRole.ADMIN) {
      return conversation;
    }

    // For AGENT: must be owner or assigned agent of the site
    const isOwner = site.ownerId === user.id;
    const isAssignedAgent = site.agents?.some((agent) => agent.id === user.id);
    if (!isOwner && !isAssignedAgent) {
      throw new ForbiddenException(
        'You do not have permission to access this conversation',
      );
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
    const conversation = await this.assertConversationSiteAccess(id, user);

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
    if (id.startsWith('admin-test-')) {
      return {
        id,
        status,
        closedReason: reason,
      } as Conversation;
    }
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
      this.ipActiveSessionsMap.forEach((sessions) => sessions.delete(id));
    }
    conversation.lastActivityAt = new Date();

    return this.conversationRepository.save(conversation);
  }

  async updateConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
    user?: JwtUser,
  ): Promise<Conversation> {
    if (user) {
      await this.assertConversationSiteAccess(id, user);
    }
    return this.updateStatusAndNotify(
      id,
      dto.status,
      dto.reason || ClosedReason.AGENT,
      dto.transcriptEmail,
      user,
    );
  }

  async updatePublicConversationStatus(
    id: string,
    dto: UpdateConversationStatusDto,
  ): Promise<CloseConversationResponseDto> {
    if (!id.startsWith('admin-test-')) {
      const conversation = await this.conversationRepository.findOne({
        where: { id },
        select: { id: true, siteId: true },
      });
      if (!conversation) {
        throw new NotFoundException(`Conversation ${id} not found`);
      }
      if (dto.siteId && conversation.siteId !== dto.siteId) {
        throw new ForbiddenException('siteId does not match conversation');
      }
    }
    const updated = await this.updateStatusAndNotify(
      id,
      dto.status,
      dto.reason || ClosedReason.VISITOR,
      dto.transcriptEmail,
    );

    return {
      conversationId: updated.id,
      status: updated.status,
      handlingStatus: updated.handlingStatus,
      closedReason: updated.closedReason,
      updatedAt: updated.updatedAt,
    };
  }

  async getPublicConversationStatus(id: string) {
    if (id.startsWith('admin-test-')) {
      return {
        conversationId: id,
        status: ConversationStatus.OPEN,
        handlingStatus: HandlingStatus.AI_HANDLING,
        closedReason: null,
      };
    }
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
    transcriptEmail?: string,
    user?: JwtUser,
  ): Promise<Conversation> {
    if (status === ConversationStatus.CLOSED) {
      const closedConv = await this.closeConversation(
        id,
        reason,
        transcriptEmail,
        user,
      );
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
      locale: message.locale,
      components: message.components,
      status: message.status,
      createdAt: message.createdAt,
      senderName: message.agent?.name ?? null,
      feedbackRating: message.feedbackRating,
      feedbackAt: message.feedbackAt,
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
    locale?: string,
    components?: Record<string, unknown>[],
    tokenCount?: number,
  ): Promise<ChatMessage> {
    // Only AI messages consume LLM tokens. Visitor and Agent messages have 0 tokens.
    let calculatedTokens = 0;
    if (senderType === SenderType.AI) {
      calculatedTokens =
        tokenCount !== undefined && tokenCount !== null
          ? tokenCount
          : content
            ? Math.max(1, Math.ceil(content.length / 4))
            : 0;
    }

    if (conversationId.startsWith('admin-test-')) {
      return {
        id: `test-msg-${Date.now()}`,
        conversationId,
        content,
        senderType,
        agentId: agentId ?? null,
        status: MessageStatus.SENT,
        createdAt: new Date(),
        tokenCount: calculatedTokens,
        responseTimeSec: null,
      } as ChatMessage;
    }
    const conversation = await this.getConversationById(conversationId);
    if (conversation.status === ConversationStatus.CLOSED) {
      throw new ForbiddenException('Conversation is closed');
    }

    // ── Turn-based Response Time Calculation for AGENT ──────────────────────
    let responseTimeSec: number | null = null;
    if (senderType === SenderType.AGENT) {
      const lastMessage = await this.chatMessageRepository.findOne({
        where: { conversationId },
        order: { createdAt: 'DESC' },
      });

      // Only compute if preceding message was from VISITOR (avoid consecutive AGENT bursts)
      if (lastMessage && lastMessage.senderType === SenderType.VISITOR) {
        const diffMs = Date.now() - new Date(lastMessage.createdAt).getTime();
        const diffSec = Math.round(diffMs / 1000);
        // Limit calculation to a 1-hour window (3600 seconds)
        if (diffSec >= 0 && diffSec <= 3600) {
          responseTimeSec = diffSec;
        }
      }
    }

    const message = this.chatMessageRepository.create({
      conversationId,
      content,
      senderType,
      agentId: agentId ?? null,
      locale: locale ?? null,
      components: components ?? null,
      tokenCount: calculatedTokens,
      responseTimeSec,
    });

    this.logger.log({
      event: 'chat_message_saved',
      conversationId,
      senderType,
      hasComponents: Boolean(components?.length),
      hasLocale: Boolean(locale),
    });

    if (senderType === SenderType.AI) {
      this.logger.log(
        `🤖 [AI Message Saved to DB] [Conv: ${conversationId}] [Locale: ${locale ?? 'auto'}]\n${content}`,
      );
    }

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
    if (conversationId.startsWith('admin-test-')) {
      return;
    }
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
    if (conversationId.startsWith('admin-test-')) {
      return;
    }
    if (!conversationId) return;
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
    transcriptEmail?: string,
    user?: JwtUser,
  ): Promise<Conversation> {
    if (user) {
      await this.assertConversationSiteAccess(id, user);
    }
    if (id.startsWith('admin-test-')) {
      this.chatGateway.notifyConversationClosed(id, 'admin-test');
      return {
        id,
        status: ConversationStatus.CLOSED,
        closedReason: reason,
      } as Conversation;
    }
    const conversation = await this.conversationRepository.findOne({
      where: { id },
      relations: { site: { owner: true } },
    });
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    const updatePayload: {
      status: ConversationStatus;
      closedReason: ClosedReason;
      visitorEmail?: string;
    } = {
      status: ConversationStatus.CLOSED,
      closedReason: reason,
    };
    if (
      transcriptEmail &&
      transcriptEmail.trim() &&
      transcriptEmail.trim() !== 'skip_email' &&
      !conversation.visitorEmail
    ) {
      updatePayload.visitorEmail = transcriptEmail.trim();
      conversation.visitorEmail = transcriptEmail.trim();
    }
    await this.conversationRepository.update(id, updatePayload);

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

    // Run entirely in the background — do NOT await so the HTTP response
    // is returned immediately (fixes the long spinner on "End Without Email").
    if (
      reason !== ClosedReason.CLEARED &&
      conversation.site &&
      conversation.site.owner
    ) {
      this.logger.log(
        `[Transcript] closeConversation conv=${conversation.id} transcriptEmail=${transcriptEmail ?? 'none'} emailTranscript=${conversation.site.emailTranscript}`,
      );
      void this.sendCloseEmails(conversation, transcriptEmail);
    }

    const updated = await this.conversationRepository.findOne({
      where: { id },
    });
    return updated ?? conversation;
  }

  /**
   * Graceful Shutdown Hook: Cancels active conversation timers on shutdown.
   */
  beforeApplicationShutdown(signal?: string): void {
    this.logger.warn(
      `Server is shutting down (${signal || 'UNKNOWN'}). Cleaning up active conversation timers...`,
    );
    this.chatTimeoutService.onModuleDestroy?.();
  }

  /** Background job: generate AI summary then enqueue summary + transcript emails. */
  private async sendCloseEmails(
    conversation: Conversation,
    transcriptEmail?: string,
  ): Promise<void> {
    try {
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

      // Only send chat transcript if emailTranscript is enabled on the site OR a transcriptEmail was explicitly requested
      this.logger.debug(
        `[Transcript] conv=${conversation.id} emailTranscript=${conversation.site?.emailTranscript} transcriptEmail=${transcriptEmail ?? 'none'} messageCount=${messageCount}`,
      );
      if (
        conversation.site &&
        (conversation.site.emailTranscript || transcriptEmail) &&
        transcriptEmail !== 'skip_email'
      ) {
        let targetEmail = transcriptEmail || conversation.visitorEmail;
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
            const booking = await this.bookingService
              .getBookingByCode(conversation.siteId, bookingCode)
              .catch(() => null);
            if (booking && booking.customerEmail) {
              targetEmail = booking.customerEmail;
              targetName = booking.customerName || targetName;
            }
          }

          this.logger.debug(
            `[Transcript] targetEmail=${targetEmail ?? 'MISSING'} targetName=${targetName ?? 'none'} bookingCode=${bookingCode ?? 'none'}`,
          );

          if (targetEmail) {
            const transcriptMessages = rawMessages
              .filter((m) => m.senderType !== SenderType.SYSTEM)
              .map((m) => {
                let cleanContent = (m.content || '')
                  .replace(/<booking-code>.*?<\/booking-code>/gs, '')
                  .replace(/<booking-cancelled>.*?<\/booking-cancelled>/gs, '')
                  .replace(/<chips>.*?<\/chips>/gs, '')
                  .trim();

                // ── Slash-command messages (sent by the widget UI) ──────────────
                // Format: /command-name {json} :: Human readable label
                // Only show the human-readable part after " :: ".
                // If no " :: " separator exists, skip the message entirely.
                if (cleanContent.startsWith('/')) {
                  const separatorIdx = cleanContent.indexOf(' :: ');
                  if (separatorIdx !== -1) {
                    const readable = cleanContent
                      .slice(separatorIdx + 4)
                      .trim();

                    // Special case: /confirm-booking — parse JSON and pretty-print
                    if (cleanContent.startsWith('/confirm-booking ')) {
                      const jsonStr = cleanContent
                        .slice('/confirm-booking '.length, separatorIdx)
                        .trim();
                      try {
                        const data = JSON.parse(jsonStr) as Record<
                          string,
                          unknown
                        >;
                        let formatted = `<strong>[Booking Confirmed]</strong>`;
                        if (typeof data.date === 'string')
                          formatted += `<br>- Date: ${data.date}`;
                        if (typeof data.timeSlot === 'string')
                          formatted += `<br>- Time: ${data.timeSlot}`;
                        if (typeof data.customerName === 'string')
                          formatted += `<br>- Name: ${data.customerName}`;
                        if (typeof data.phone === 'string')
                          formatted += `<br>- Phone: ${data.phone}`;
                        cleanContent = formatted;
                      } catch {
                        cleanContent =
                          readable || '<strong>[Booking Confirmed]</strong>';
                      }
                    } else {
                      cleanContent = readable;
                    }
                  } else {
                    // No readable label — skip this internal widget message
                    cleanContent = '';
                  }
                } else {
                  // Convert simple markdown bold (**text**) to <strong> for email
                  cleanContent = cleanContent
                    .replace(/\*\*(.*?)\*\*/gs, '<strong>$1</strong>')
                    .replace(/\n/g, '<br>');
                }

                const isVisitor = m.senderType === SenderType.VISITOR;
                const isBot = m.senderType === SenderType.AI;
                const isAgent = m.senderType === SenderType.AGENT;

                const displayName = isVisitor
                  ? 'You'
                  : isBot
                    ? 'Bot'
                    : m.agent?.name || 'Agent';

                const badgeText = isVisitor
                  ? 'You'
                  : isBot
                    ? 'Bot'
                    : m.agent?.name || 'Agent';

                // Color Themes:
                // Visitor: Soft Indigo/Blue (#EEF2FF bg, #4F46E5 badge & border)
                // Bot (AI): Soft Slate/White with Violet Accent (#F8FAFC bg, #8B5CF6 badge & border)
                // Agent: Soft Emerald/Green (#F0FDF4 bg, #10B981 badge & border)
                const bubbleBg = isVisitor
                  ? '#EEF2FF'
                  : isBot
                    ? '#F8FAFC'
                    : '#F0FDF4';
                const bubbleBorder = isVisitor
                  ? '#C7D2FE'
                  : isBot
                    ? '#E2E8F0'
                    : '#BBF7D0';
                const accentColor = isVisitor
                  ? '#4F46E5'
                  : isBot
                    ? '#8B5CF6'
                    : '#10B981';
                const badgeBg = isVisitor
                  ? '#4F46E5'
                  : isBot
                    ? '#8B5CF6'
                    : '#10B981';
                const textColor = isVisitor
                  ? '#1E1B4B'
                  : isBot
                    ? '#0F172A'
                    : '#064E3B';
                const timeColor = isVisitor
                  ? '#6366F1'
                  : isBot
                    ? '#64748B'
                    : '#059669';

                return {
                  displayName,
                  content: cleanContent,
                  timestamp: this.formatForEmail(
                    m.createdAt,
                    conversation.timezone,
                  ),
                  senderType: m.senderType,
                  isVisitor,
                  isBot,
                  isAgent,
                  badgeText,
                  bubbleBg,
                  bubbleBorder,
                  accentColor,
                  badgeBg,
                  textColor,
                  timeColor,
                };
              })
              .filter((m) => m.content.length > 0);

            this.logger.debug(
              `[Transcript] filtered messages count=${transcriptMessages.length} (raw=${rawMessages.length})`,
            );

            if (transcriptMessages.length > 0) {
              this.logger.log(
                `[Transcript] Enqueueing transcript email to ${targetEmail}`,
              );

              // Clean visitorName (e.g. remove "[NONE]" or "[NONE] hi")
              let sanitizedVisitorName = (targetName || '')
                .replace(/^\[NONE\]\s*/i, '')
                .trim();
              if (
                !sanitizedVisitorName ||
                sanitizedVisitorName.toLowerCase() === 'none'
              ) {
                sanitizedVisitorName = 'Customer';
              }

              void this.emailQueueService.enqueueChatTranscriptEmail({
                to: targetEmail,
                visitorName: sanitizedVisitorName,
                siteName: conversation.site.name || 'Support Chat',
                messages: transcriptMessages,
                startedAt: this.formatForEmail(
                  conversation.createdAt,
                  conversation.timezone,
                ),
                closedAt: this.formatForEmail(
                  new Date(),
                  conversation.timezone,
                ),
                timezone: conversation.timezone ?? 'UTC',
              });
            } else {
              this.logger.warn(
                `[Transcript] Skipped — no displayable messages after filtering (conv=${conversation.id})`,
              );
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(
        'sendCloseEmails failed: ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  async deleteConversation(id: string, user?: JwtUser): Promise<Conversation> {
    if (user) {
      await this.assertConversationSiteAccess(id, user);
    }
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

  /**
   * Format a Date for use in email transcript timestamps.
   * Converts to the visitor's local timezone so the time matches what
   * they saw in the chat widget (which uses the browser's local clock).
   *
   * Falls back to "Asia/Ho_Chi_Minh" when no timezone is stored.
   */
  private formatForEmail(date: Date, timezone: string | null): string {
    const tz = timezone ?? 'Asia/Ho_Chi_Minh';
    try {
      return date.toLocaleString('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    } catch {
      // Fallback: invalid timezone string stored in DB
      return date.toLocaleString('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
    }
  }

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

  // ─── Feedback ────────────────────────────────────────────────────────────

  /**
   * Submit visitor thumbs up / down feedback on an AI message.
   */
  async submitMessageFeedback(
    messageId: string,
    dto: SubmitMessageFeedbackDto,
  ): Promise<MessageFeedbackResponseDto> {
    const message = await this.chatMessageRepository.findOne({
      where: { id: messageId },
    });

    if (!message || message.senderType !== SenderType.AI) {
      throw new NotFoundException(
        `AI message with ID "${messageId}" not found`,
      );
    }

    message.feedbackRating = dto.rating;
    message.feedbackAt = new Date();

    const updated = await this.chatMessageRepository.save(message);

    return {
      id: updated.id,
      feedbackRating: updated.feedbackRating as FeedbackRating,
    };
  }
}
