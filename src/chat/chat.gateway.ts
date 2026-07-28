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
import { Server, Socket } from 'socket.io';
import { UserRole } from 'src/user/enums/user-role.enum';
import { Logger } from '@nestjs/common';

type JwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
};

type SocketUser = {
  id: string;
  email: string;
  role: UserRole;
};

type SocketData = {
  user?: SocketUser;
};

type ChatMessagePayload = string | { message: string };

export type DocumentNotificationPayload =
  | {
      type: 'document-processing';
      documentId: string;
      filename: string;
      status: 'processing';
    }
  | {
      type: 'document-ready';
      documentId: string;
      filename: string;
      status: 'ready';
      processedAt: string;
    };

const MAX_MESSAGE_LENGTH = 1000;

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL,
  },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ChatGateway.name);

  constructor(private readonly jwtService: JwtService) {}

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
        next(new Error('Missing access token'));
        return;
      }

      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const socketData = client.data as SocketData;

      socketData.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
      };

      next();
    } catch {
      next(new Error('Invalid or expired access token'));
    }
  }

  handleConnection(client: Socket) {
    const socketData = client.data as SocketData;
    const user = socketData.user;

    if (!user) {
      client.disconnect();
      return;
    }

    this.logger.log(`Client connected: ${client.id} (${user.email})`);
    void client.join(this.getNotificationRoom(user.id));
    client.emit('message', `Server: connected as ${user.email}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

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

  emitToUser(userId: string, payload: DocumentNotificationPayload): void {
    this.server
      .to(this.getNotificationRoom(userId))
      .emit('notification', payload);
  }

  emitDocumentStatusToUsers(
    userIds: Array<string | null | undefined>,
    payload: DocumentNotificationPayload,
  ): void {
    const rooms = [...new Set(userIds)]
      .filter(
        (userId): userId is string =>
          typeof userId === 'string' && userId.trim().length > 0,
      )
      .map((userId) => this.getNotificationRoom(userId));

    if (rooms.length === 0) {
      this.logger.warn(
        `Skipped document status notification for document ${payload.documentId}: no recipients`,
      );
      return;
    }

    this.server.to(rooms).emit('document-status-changed', payload);
    this.logger.log(
      `Emitted ${payload.status} status for document ${payload.documentId} to ${rooms.length} user room(s)`,
    );
  }

  private getNotificationRoom(userId: string): string {
    return `notification-${userId}`;
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
}
