import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { WsAuthMiddleware } from '../auth/middlewares/ws-auth.middleware';
import { JwtUser } from '../auth/types/jwt-user.type';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/api/v1/bookings',
})
export class BookingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(BookingGateway.name);

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

    const siteId = client.handshake.query.siteId as string;
    if (siteId) {
      void client.join(this.getSiteRoom(siteId));
      this.logger.log(
        `Client ${client.id} joined booking room: site-${siteId}`,
      );
    }

    this.logger.log(
      `Client connected to bookings: ${client.id} (${user.email})`,
    );
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from bookings: ${client.id}`);
  }

  @SubscribeMessage('join_site')
  handleJoinSite(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { siteId: string },
  ) {
    const { siteId } = payload;
    if (siteId) {
      void client.join(this.getSiteRoom(siteId));
      this.logger.log(
        `Client ${client.id} explicitly joined booking room: site-${siteId}`,
      );
    }
  }

  private getSiteRoom(siteId: string): string {
    return `room:site:${siteId}`;
  }

  public emitSlotHeld(
    siteId: string,
    payload: { resourceId: string; startAt: string; endAt: string },
  ): void {
    this.server.to(this.getSiteRoom(siteId)).emit('booking_slot_held', payload);
  }

  public emitSlotsHeld(
    siteId: string,
    payload: Array<{ resourceId: string; startAt: string; endAt: string }>,
  ): void {
    this.server
      .to(this.getSiteRoom(siteId))
      .emit('booking_slots_held', payload);
  }

  public emitSlotConfirmed(
    siteId: string,
    payload: { resourceId: string; startAt: string; endAt: string },
  ): void {
    this.server
      .to(this.getSiteRoom(siteId))
      .emit('booking_slot_confirmed', payload);
  }

  public emitSlotReleased(
    siteId: string,
    payload: { resourceId: string; startAt: string; endAt: string },
  ): void {
    this.server
      .to(this.getSiteRoom(siteId))
      .emit('booking_slot_released', payload);
  }
}
