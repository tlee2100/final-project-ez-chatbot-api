import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { paginate, Paginated } from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, Brackets } from 'typeorm';
import { Site } from '../site/entities/site.entity';
import { UserRole } from '../user/enums/user-role.enum';
import {
  Conversation,
  ConversationStatus,
  HandlingStatus,
} from './entities/conversation.entity';
import { ChatMessage, SenderType } from './entities/chat-message.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { JwtUser } from '../auth/types/jwt-user.type';
import { NotificationService } from '../notification/notification.service';
import { NotificationType } from '../notification/enums/notification-type.enum';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
    @InjectRepository(ChatMessage)
    private readonly chatMessageRepository: Repository<ChatMessage>,
    private readonly notificationService: NotificationService,
  ) {}

  // ─── Client Connected ──────────────────────────────────────────────────────

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

  // ─── Create Conversation ───────────────────────────────────────────────────

  async createConversation(
    dto: CreateConversationDto,
  ): Promise<{ conversation: Conversation; firstMessage: ChatMessage }> {
    const site = await this.siteRepository.findOne({
      where: { id: dto.siteId },
      relations: { agents: true },
    });
    if (!site) {
      throw new NotFoundException(`Site ${dto.siteId} not found`);
    }

    return this.conversationRepository.manager.transaction(
      async (transactionalEntityManager) => {
        const conversation = transactionalEntityManager.create(Conversation, {
          siteId: dto.siteId,
          visitorName: dto.visitorName,
          visitorEmail: dto.visitorEmail,
          status: ConversationStatus.OPEN,
          handlingStatus: HandlingStatus.WAITING_FOR_AGENT,
          lastActivityAt: new Date(),
        });
        const savedConversation = await transactionalEntityManager.save(
          Conversation,
          conversation,
        );

        const message = transactionalEntityManager.create(ChatMessage, {
          conversationId: savedConversation.id,
          senderType: SenderType.VISITOR,
          content: dto.firstMessage,
        });
        const savedMessage = await transactionalEntityManager.save(
          ChatMessage,
          message,
        );

        this.logger.log(
          `New conversation ${savedConversation.id} created for site ${dto.siteId}`,
        );

        // Notify agents
        const recipientIds = new Set([
          site.ownerId,
          ...site.agents.map((a) => a.id),
        ]);
        for (const userId of recipientIds) {
          try {
            await this.notificationService.create({
              recipientId: userId,
              type: NotificationType.CONVERSATION_WAITING,
              title: 'New Conversation',
              message: `A new conversation with ${dto.visitorName} is waiting for an agent.`,
              siteId: site.id,
              conversationId: savedConversation.id,
            });
          } catch (error) {
            this.logger.error(
              `Failed to notify user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        return { conversation: savedConversation, firstMessage: savedMessage };
      },
    );
  }

  // ─── Get Active Conversations ──────────────────────────────────────────────

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

    if (allSiteIds.length === 0) {
      return this.emptyPaginated(query);
    }

    const isAdminOrAbove =
      user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN;

    const queryBuilder = this.conversationRepository
      .createQueryBuilder('conversation')
      .leftJoinAndSelect('conversation.site', 'site')
      .leftJoinAndSelect('conversation.agent', 'agent')
      .where('conversation.status != :closed', {
        closed: ConversationStatus.CLOSED,
      });

    if (isAdminOrAbove) {
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
        siteId: true,
        status: true,
        handlingStatus: true,
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

    const isAdminOrAbove =
      agentUser.role === UserRole.SUPER_ADMIN ||
      agentUser.role === UserRole.ADMIN;

    // Block if another agent already owns it (unless admin/superadmin)
    if (
      conversation.agentId &&
      conversation.agentId !== agentUser.id &&
      !isAdminOrAbove
    ) {
      throw new UnauthorizedException(
        'This conversation is already being handled by another agent',
      );
    }

    let isNewAssignment = false;
    if (!conversation.agentId) {
      conversation.agentId = agentUser.id;
      conversation.handlingStatus = HandlingStatus.AGENT_HANDLING;
      await this.conversationRepository.save(conversation);
      isNewAssignment = true;
      this.logger.log(
        `Agent ${agentUser.email} assigned to conversation ${conversationId}`,
      );
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

  // ─── Messages ─────────────────────────────────────────────────────────────

  async getMessagesForConversation(
    conversationId: string,
    cursor?: Date,
    limit = 50,
  ): Promise<ChatMessage[]> {
    const messages = await this.chatMessageRepository.find({
      where: cursor
        ? { conversationId, createdAt: LessThan(cursor) }
        : { conversationId },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return messages.reverse();
  }

  async saveMessage(
    conversationId: string,
    content: string,
    senderType: SenderType,
    agentId?: string,
  ): Promise<ChatMessage> {
    const message = this.chatMessageRepository.create({
      conversationId,
      content,
      senderType,
      agentId: agentId ?? null,
    });
    const savedMessage = await this.chatMessageRepository.save(message);

    // Update lastActivityAt
    await this.conversationRepository.update(conversationId, {
      lastActivityAt: new Date(),
    });

    return savedMessage;
  }

  // ─── Close / Delete ────────────────────────────────────────────────────────

  async closeConversation(id: string): Promise<Conversation> {
    const conversation = await this.getConversationById(id);
    await this.conversationRepository.update(id, {
      status: ConversationStatus.CLOSED,
    });

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
    return conversation;
  }

  async getIdleOpenConversations(cutoffDate: Date): Promise<Conversation[]> {
    return this.conversationRepository.find({
      where: {
        status: ConversationStatus.OPEN,
        lastActivityAt: LessThan(cutoffDate),
      },
    });
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

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
