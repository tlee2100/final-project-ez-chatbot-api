import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { UserRole } from 'src/user/enums/user-role.enum';
import type { JwtUser } from 'src/auth/types/jwt-user.type';
import { ChatService } from './chat.service';
import { SenderType } from './entities/chat-message.entity';
import { Conversation } from './entities/conversation.entity';

type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
  organizationId: string | null;
};

type SocketData = {
  user?: JwtUser;
  visitor?: {
    conversationId: string;
  };
};

type ChatMessagePayload = string | { message: string };

const MAX_MESSAGE_LENGTH = 1000;
const frontendOrigins = process.env.FRONTEND_URL?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: frontendOrigins,
  },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly chatService: ChatService,
  ) {}

  @WebSocketServer()
  server!: Server;

  afterInit(server: Server) {
    server.use((client: Socket, next) => {
      void this.authenticateClient(client, next);
    });
  }

  private async authenticateClient(
    client: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      const token = this.extractToken(client);

      if (!token) {
        const conversationId = this.extractVisitorConversationId(client);
        if (conversationId) {
          const socketData = client.data as SocketData;
          socketData.visitor = { conversationId };
          next();
          return;
        }

        next(new Error('Missing access token or visitor conversation ID'));
        return;
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const socketData = client.data as SocketData;

      socketData.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        organizationId: payload.organizationId,
      };

      next();
    } catch {
      next(new Error('Invalid or expired access token'));
    }
  }

  async handleConnection(client: Socket) {
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
      client.emit('connected', { message: `Connected as visitor` });
      return;
    }

    if (!user) return;

    this.logger.log(`Client connected: ${client.id} (${user.email})`);

    // Join site rooms for inbox real-time updates
    await this.chatService.handleClientConnected(
      (room) => void client.join(room),
      user,
    );

    client.emit('connected', { message: `Connected as ${user.email}` });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ─── Legacy message event (kept for backward compat) ──────────────────────

  @SubscribeMessage('message')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: ChatMessagePayload,
  ) {
    const socketData = client.data as SocketData;
    const user = socketData.user;

    if (!user) {
      throw new WsException('Unauthenticated client');
    }

    const message = this.validateMessagePayload(payload);
    const sender = user.email;
    const text = `${sender}: ${message}`;

    this.logger.log(`Message received from ${sender}: ${message}`);
    this.server.emit('message', text);

    return message;
  }

  // ─── Live-chat: Join conversation room (agent "Takes Chat") ───────────────

  @SubscribeMessage('joinConversation')
  async handleJoinConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): Promise<void> {
    const user = (client.data as SocketData).user;
    if (!user) {
      client.emit('joinError', { message: 'Unauthenticated' });
      return;
    }

    try {
      const { conversation, isNewAssignment } =
        await this.chatService.assignAgentToConversation(
          payload.conversationId,
          user,
        );

      // Notify the whole site room so other agents' inboxes refresh
      this.notifyConversationAssigned(conversation.id, conversation.siteId);

      if (isNewAssignment) {
        const joinMsg = await this.chatService.saveMessage(
          payload.conversationId,
          'An agent has joined the chat.',
          SenderType.SYSTEM,
        );

        // Broadcast system message to the conversation room
        this.server
          .to(`conversation-${payload.conversationId}`)
          .emit('newMessage', {
            id: joinMsg.id,
            conversationId: payload.conversationId,
            content: joinMsg.content,
            senderType: joinMsg.senderType,
            createdAt: joinMsg.createdAt,
          });
      }

      void client.join(`conversation-${payload.conversationId}`);
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

  // ─── Live-chat: Subscribe (preview without claiming) ──────────────────────

  @SubscribeMessage('subscribeConversation')
  handleSubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { conversationId: string },
  ): void {
    void client.join(`conversation-${payload.conversationId}`);
    this.logger.log(
      `Client ${client.id} subscribed to conversation ${payload.conversationId}`,
    );
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
      const savedMessage = await this.chatService.saveMessage(
        payload.conversationId,
        payload.content,
        payload.senderType,
        payload.senderType === SenderType.AGENT ? user?.id : undefined,
      );

      const messageEvent = {
        id: savedMessage.id,
        conversationId: payload.conversationId,
        content: savedMessage.content,
        senderType: savedMessage.senderType,
        agentId: savedMessage.agentId,
        createdAt: savedMessage.createdAt,
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

      // Notify the site room so the conversation list re-sorts
      const conversation = await this.chatService.getConversationById(
        payload.conversationId,
      );
      this.server
        .to(`site-${conversation.siteId}`)
        .emit('conversationActivity', { id: payload.conversationId });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to send message';
      client.emit('messageError', { message });
    }
  }

  // ─── Emit helpers (called by the REST controller) ─────────────────────────

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

    // Also notify the site room so agents' inboxes refresh and drop the
    // closed conversation without a manual reload.
    if (siteId) {
      this.server.to(`site-${siteId}`).emit('conversationClosed', {
        id: conversationId,
      });
    }
  }

  // ─── System notifications ────────────────────────────────────────────────

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

  private extractToken(client: Socket): string | null {
    const authToken = (client.handshake.auth as Partial<{ token: string }>)
      .token;
    if (typeof authToken === 'string') {
      return authToken;
    }

    const queryToken = client.handshake.query?.token;
    if (typeof queryToken === 'string') {
      return queryToken;
    }

    const authorization = client.handshake.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      return authorization.slice(7);
    }

    return null;
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
