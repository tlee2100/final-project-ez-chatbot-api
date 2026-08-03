import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { Site } from '../../site/entities/site.entity';
import { Conversation } from '../../chat/entities/conversation.entity';
import { NotificationType } from '../enums/notification-type.enum';

@Entity('notifications')
@Index('IDX_notifications_recipient_readAt', ['recipient', 'readAt'])
@Index('IDX_notifications_conversation', ['conversation'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  recipientId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'recipientId' })
  recipient: User;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ type: 'varchar', length: 120 })
  title: string;

  @Column({ type: 'varchar', length: 500 })
  message: string;

  @Column({ type: 'uuid', nullable: true })
  siteId: string | null;

  @ManyToOne(() => Site, { nullable: true })
  @JoinColumn({ name: 'siteId' })
  site: Site | null;

  @Column({ type: 'uuid', nullable: true })
  conversationId: string | null;

  @ManyToOne(() => Conversation, { nullable: true })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  readAt: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date;
}
