import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Conversation } from './conversation.entity';
import { User } from '../../user/entities/user.entity';

export enum SenderType {
  VISITOR = 'VISITOR',
  AGENT = 'AGENT',
  AI = 'AI',
  SYSTEM = 'SYSTEM',
}

export enum MessageStatus {
  SENT = 'SENT',
  DELIVERED = 'DELIVERED',
  READ = 'READ',
}

export enum FeedbackRating {
  HELPFUL = 'HELPFUL',
  UNHELPFUL = 'UNHELPFUL',
}

@Entity('chat_messages')
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, (c) => c.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversationId' })
  conversation: Conversation;

  @Column({ type: 'enum', enum: SenderType })
  senderType: SenderType;

  /** Null when the sender is the visitor */
  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'agentId' })
  agent: User | null;

  @Column('text')
  content: string;

  @Column({ type: 'varchar', length: 35, nullable: true })
  locale: string | null;

  @Column({ type: 'jsonb', nullable: true })
  components: Record<string, unknown>[] | null;

  @Column({
    type: 'enum',
    enum: MessageStatus,
    default: MessageStatus.SENT,
  })
  status: MessageStatus;

  @Column({
    type: 'enum',
    enum: FeedbackRating,
    nullable: true,
    default: null,
  })
  feedbackRating: FeedbackRating | null;

  @Column({ type: 'timestamptz', nullable: true, default: null })
  feedbackAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
