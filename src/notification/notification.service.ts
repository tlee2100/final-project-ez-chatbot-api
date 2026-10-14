import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { NotificationGateway } from './notification.gateway';
import { NotificationType } from './enums/notification-type.enum';

@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    private readonly notificationGateway: NotificationGateway,
  ) {}

  async create(
    createNotificationDto: CreateNotificationDto,
  ): Promise<Notification> {
    const notification = this.notificationRepository.create({
      ...createNotificationDto,
      recipient: { id: createNotificationDto.recipientId },
      site: createNotificationDto.siteId
        ? { id: createNotificationDto.siteId }
        : null,
      conversation: createNotificationDto.conversationId
        ? { id: createNotificationDto.conversationId }
        : null,
    });

    const savedNotification =
      await this.notificationRepository.save(notification);

    // Emit to client
    this.notificationGateway.emitNewNotification(
      createNotificationDto.recipientId,
      savedNotification,
    );

    return savedNotification;
  }

  async emitSentimentAlert(
    userIds: string[],
    siteId: string,
    conversationId: string,
    text: string,
  ): Promise<void> {
    const promises = userIds.map((userId) =>
      this.create({
        recipientId: userId,
        type: NotificationType.NEGATIVE_SENTIMENT,
        title: 'Negative Sentiment Detected',
        message: `Visitor expressed negative sentiment: "${text}"`,
        siteId,
        conversationId,
      }),
    );
    await Promise.all(promises);
  }

  async findAll(
    userId: string,
    isRead?: boolean,
    page?: number,
    limit?: number,
  ): Promise<{ data: Notification[]; totalItems: number }> {
    const query = this.notificationRepository
      .createQueryBuilder('notification')
      .leftJoinAndSelect('notification.site', 'site')
      .leftJoinAndSelect('notification.conversation', 'conversation')
      .where('notification.recipientId = :userId', { userId })
      .orderBy('notification.createdAt', 'DESC');

    if (isRead !== undefined) {
      if (isRead) {
        query.andWhere('notification.readAt IS NOT NULL');
      } else {
        query.andWhere('notification.readAt IS NULL');
      }
    }

    if (page !== undefined && limit !== undefined) {
      query.skip((page - 1) * limit).take(limit);
    }

    const [data, totalItems] = await query.getManyAndCount();
    return { data, totalItems };
  }

  async findUnread(userId: string): Promise<Notification[]> {
    const res = await this.findAll(userId, false);
    return res.data;
  }

  async findOne(id: string, userId: string): Promise<Notification> {
    const notification = await this.notificationRepository.findOne({
      where: { id, recipient: { id: userId } },
      relations: { site: true, conversation: true },
    });

    if (!notification) {
      throw new NotFoundException(`Notification with ID ${id} not found`);
    }

    return notification;
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.notificationRepository.count({
      where: { recipient: { id: userId }, readAt: IsNull() },
    });
  }

  async markAsRead(id: string, userId: string): Promise<Notification> {
    const notification = await this.findOne(id, userId);
    if (!notification.readAt) {
      notification.readAt = new Date();
      return this.notificationRepository.save(notification);
    }
    return notification;
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.notificationRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ readAt: new Date() })
      .where('recipientId = :userId', { userId })
      .andWhere('readAt IS NULL')
      .execute();
  }

  async remove(id: string, userId: string): Promise<void> {
    const notification = await this.findOne(id, userId);
    await this.notificationRepository.remove(notification);
  }

  async removeAllForUser(userId: string): Promise<void> {
    await this.notificationRepository.delete({ recipient: { id: userId } });
  }
}
