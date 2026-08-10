import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { WsAuthMiddleware } from '../auth/middlewares/ws-auth.middleware';
import { JwtUser } from '../auth/types/jwt-user.type';
import { Notification } from './entities/notification.entity';
import { Logger } from '@nestjs/common';
import { DocumentNotificationPayload } from './types/document-notification-payload.type';
import { ChatToastPayload } from './types/chat-toast-payload.type';

// const frontendOrigins = process.env.FRONTEND_URL?.split(',')
//   .map((origin) => origin.trim())
//   .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/api/v1/notifications',
})
export class NotificationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  constructor(private readonly jwtService: JwtService) {}

  @WebSocketServer()
  server!: Server;

  afterInit(server: Server) {
    server.use(WsAuthMiddleware(this.jwtService));
  }

  handleConnection(client: Socket) {
    const user = (client.data as { user?: JwtUser })?.user;
    if (!user) {
      client.disconnect();
      return;
    }

    this.logger.log(
      `Client connected to notifications: ${client.id} (${user.email})`,
    );
    void client.join(this.getNotificationRoom(user.id));
    void client.join(this.getNotificationRoom(user.id));
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from notifications: ${client.id}`);
  }

  public emitNewNotification(userId: string, notification: Notification): void {
    this.server
      .to(this.getNotificationRoom(userId))
      .emit('notification.new', notification);
  }

  public emitChatToast(agentId: string, payload: ChatToastPayload): void {
    this.server
      .to(this.getNotificationRoom(agentId))
      .emit('chat.toast', payload);
    this.logger.log(
      `chat.toast emitted to agent ${agentId} for conversation ${payload.conversationId}`,
    );
  }

  private getNotificationRoom(userId: string): string {
    return `notification-${userId}`;
  }

  public emitDocumentStatusToUsers(
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
      `Emitted ${payload.status} status for document ${payload.documentId} to ${rooms.length} user room(s) in Notification Socket`,
    );
  }
}
