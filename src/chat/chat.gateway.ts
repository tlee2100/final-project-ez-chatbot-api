import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Logger, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { UserRole } from '../user/enums/user-role.enum';
import type { JwtUser } from '../auth/types/jwt-user.type';
import { Roles } from '../auth/decorators/roles.decorator';
import { WsRolesGuard } from '../auth/guards/ws-roles.guard';
import { ChatService } from './chat.service';
import { SenderType } from './entities/chat-message.entity';
import { Conversation } from './entities/conversation.entity';
import { NotificationGateway } from '../notification/notification.gateway';
import { ChatToastPayload } from '../notification/types/chat-toast-payload.type';
import type { RawPageContext } from './interfaces/page-context.interface';
import { extractToken } from '../auth/middlewares/ws-auth.middleware';

type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
};

export type SocketData = {
  user?: JwtUser;
  visitor?: {
    conversationId?: string;
    siteId?: string;
  };
};

export type ChatMessagePayload = string | { message: string };

// const frontendOrigins = process.env.FRONTEND_URL?.split(',')
//   .map((origin) => origin.trim())
//   .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
    private readonly notificationGateway: NotificationGateway,
  ) {}

  @WebSocketServer()
  server!: Server;

  afterInit(server: Server) {
    server.use((client: Socket, next) => {
      void this.authenticateClient(client, next);
    });

    this.chatService.onConversationsClosed((conversationIds) => {
      for (const id of conversationIds) {
        this.notifyConversationClosed(id);
        this.emitConversationStatusChanged(id, 'CLOSED');
      }
    });
  }

  private async authenticateClient(
    client: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      const token = extractToken(client);

      if (!token) {
        const conversationId = this.extractVisitorConversationId(client);
        const siteId = (client.handshake.auth?.siteId ||
          client.handshake.query?.siteId) as string;

        if (conversationId || siteId) {
          const socketData = client.data as SocketData;
          socketData.visitor = {
            conversationId: conversationId || undefined,
            siteId: siteId || undefined,
          };
          next();
          return;
        }

        next(new Error('Missing access token or visitor conversation ID'));
        return;
      }

      const payload = await this.jwtService.verifyAsync<
        JwtPayload & { type?: string; conversationId?: string; siteId?: string }
      >(token);
      const socketData = client.data as SocketData;

      if (payload.type === 'visitor') {
        socketData.visitor = {
          conversationId: payload.conversationId || payload.sub,
          siteId: payload.siteId,
        };
      } else {
        socketData.user = {
          id: payload.sub,
          email: payload.email,
          role: payload.role,
          organizationId: payload.organizationId,
        };
      }

      next();
    } catch {
      next(new Error('Invalid or expired access token'));
    }
  }

  async handleConnection(client: Socket) {
    await this.chatService.handleConnection(client);
  }

  handleDisconnect(client: Socket) {
    this.chatService.handleDisconnect(client);
  }

  // ─── Legacy message event (kept for backward compat) ──────────────────────

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChatMessagePayload,
  ) {
    return this.chatService.handleLegacyMessage(client, payload);
  }

  // ─── Live-chat: Join conversation room (agent "Takes Chat") ───────────────

  @UseGuards(WsRolesGuard)
  @Roles(UserRole.AGENT)
  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): Promise<void> {
    await this.chatService.handleJoinConversation(client, payload);
  }

  // ─── Live-chat: Subscribe (preview without claiming) ──────────────────────

  @UseGuards(WsRolesGuard)
  @Roles(UserRole.AGENT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @SubscribeMessage('subscribeConversation')
  async handleSubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): Promise<void> {
    await this.chatService.handleSubscribeConversation(client, payload);
  }

  // ─── Live-chat: Send message ───────────────────────────────────────────────

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      conversationId: string;
      content: string;
      senderType: SenderType;
      localId?: string;
    } & RawPageContext,
  ): Promise<void> {
    await this.chatService.handleSendMessage(client, payload);
  }

  // ─── Live-chat: Typing & Status ──────────────────────────────────────────

  @SubscribeMessage('conversation-typing')
  handleTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): void {
    this.chatService.handleTyping(client, payload);
  }

  @SubscribeMessage('conversation-read')
  async handleConversationRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): Promise<void> {
    await this.chatService.handleConversationRead(client, payload);
  }

  // ─── Emit helpers (called by the REST controller / service) ───────────────

  emitChatToastToAgent(agentId: string, payload: ChatToastPayload): void {
    this.notificationGateway.emitChatToast(agentId, payload);
    this.logger.log(
      `Chat toast forwarded to agent ${agentId} for conversation ${payload.conversationId}`,
    );
  }

  notifyAgentsOfNewConversation(conversation: Conversation): void {
    this.server.to(`site-${conversation.siteId}`).emit('newConversation', {
      id: conversation.id,
      siteId: conversation.siteId,
      visitorName: conversation.visitorName,
      visitorEmail: conversation.visitorEmail,
      status: conversation.status,
      handlingStatus: conversation.handlingStatus,
      createdAt: new Date().toISOString(),
    });
    this.logger.log(
      `Notified site-${conversation.siteId} of new conversation ${conversation.id}`,
    );
  }

  notifyConversationAssigned(conversationId: string, siteId: string): void {
    this.server
      .to(`site-${siteId}`)
      .emit('conversationAssigned', { id: conversationId });
  }

  notifyConversationClosed(conversationId: string, siteId?: string): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('conversationClosed', { id: conversationId });

    if (siteId) {
      this.server.to(`site-${siteId}`).emit('conversationClosed', {
        id: conversationId,
      });
    }
  }

  notifyHandoffRequested(conversationId: string, siteId: string): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('handlingStatusUpdated', {
        conversationId,
        handlingStatus: 'WAITING_FOR_AGENT',
      });
    this.server.to(`site-${siteId}`).emit('conversationActivity', {
      id: conversationId,
    });
    this.logger.log(
      `Handoff requested for conversation ${conversationId} (site ${siteId})`,
    );
  }

  emitConversationStatusChanged(conversationId: string, status: string): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('conversationStatusChanged', { conversationId, status });
  }

  broadcastSiteSettingsUpdated(
    conversationIds: string[],
    settings: unknown,
  ): void {
    for (const id of conversationIds) {
      this.server
        .to(`conversation-${id}`)
        .emit('siteSettingsUpdated', settings);
    }
  }

  // ─── Booking Emit Helpers ────────────────────────────────────────────────

  emitBookingSlots(conversationId: string, payload: unknown): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('bookingSlots', { conversationId, payload });
  }

  emitBookingSummary(conversationId: string, payload: unknown): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('bookingSummary', { conversationId, payload });
  }

  emitBookingSuccess(conversationId: string, payload: unknown): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('bookingSuccess', { conversationId, payload });
  }

  emitBookingCancellation(conversationId: string, payload: unknown): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('bookingCancellation', { conversationId, payload });
  }

  emitBookingCancelled(conversationId: string, payload: unknown): void {
    this.server
      .to(`conversation-${conversationId}`)
      .emit('bookingCancelled', { conversationId, payload });
  }

  private extractVisitorConversationId(client: Socket): string | null {
    const authConvId = (
      client.handshake.auth as Partial<{ conversationId: string }>
    ).conversationId;
    if (typeof authConvId === 'string') {
      return authConvId;
    }

    const queryConvId = client.handshake.query?.conversationId;
    if (typeof queryConvId === 'string') {
      return queryConvId;
    }

    return null;
  }
}
