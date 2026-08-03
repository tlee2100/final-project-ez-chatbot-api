import {
  Controller,
  Get,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Request } from 'express';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { NotificationResponseDto } from './dto/notification-response.dto';
// import { NotificationType } from './enums/notification-type.enum';
import { Notification } from './entities/notification.entity';

interface RequestWithUser extends Request {
  user: {
    id: string;
    email: string;
    role: string;
  };
}

function mapToDto(notification: Notification): NotificationResponseDto {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    message: notification.message,
    siteId: notification.site?.id || null,
    conversationId: notification.conversation?.id || null,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
    updatedAt: notification.updatedAt,
  };
}

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @ApiOperation({ summary: 'Get all notifications for the current user' })
  @Get()
  async findAll(@Req() req: RequestWithUser, @Query('isRead') isRead?: string) {
    const userId = req.user.id;
    const isReadBool =
      isRead === 'true' ? true : isRead === 'false' ? false : undefined;
    const notifications = await this.notificationService.findAll(
      userId,
      isReadBool,
    );
    return notifications.map(mapToDto);
  }

  @ApiOperation({ summary: 'Get unread notification count' })
  @Get('unread-count')
  async getUnreadCount(@Req() req: RequestWithUser) {
    const count = await this.notificationService.getUnreadCount(req.user.id);
    return { count };
  }

  @ApiOperation({ summary: 'Get a specific notification' })
  @Get(':id')
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    const notification = await this.notificationService.findOne(
      id,
      req.user.id,
    );
    return mapToDto(notification);
  }

  @ApiOperation({ summary: 'Mark all notifications as read' })
  @Patch('mark-all-read')
  markAllAsRead(@Req() req: RequestWithUser) {
    return this.notificationService.markAllAsRead(req.user.id);
  }

  @ApiOperation({ summary: 'Mark a specific notification as read' })
  @Patch(':id/mark-read')
  async markAsRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ) {
    const notification = await this.notificationService.markAsRead(
      id,
      req.user.id,
    );
    return mapToDto(notification);
  }

  @ApiOperation({ summary: 'Delete a specific notification' })
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.notificationService.remove(id, req.user.id);
  }

  @ApiOperation({ summary: 'Delete all notifications for the current user' })
  @Delete()
  removeAll(@Req() req: RequestWithUser) {
    return this.notificationService.removeAllForUser(req.user.id);
  }
}
