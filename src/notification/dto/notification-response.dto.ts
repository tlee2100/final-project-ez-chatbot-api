import { NotificationType } from '../enums/notification-type.enum';

export class NotificationResponseDto {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  siteId?: string | null;
  conversationId?: string | null;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
