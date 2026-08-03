import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { User } from '../../user/entities/user.entity';
import { ChatMessage } from './chat-message.entity';

export enum ConversationStatus {
  OPEN = 'OPEN',
  PAUSED = 'PAUSED',
  CLOSED = 'CLOSED',
}

export enum HandlingStatus {
  AI_HANDLING = 'AI_HANDLING',
  WAITING_FOR_AGENT = 'WAITING_FOR_AGENT',
  AGENT_HANDLING = 'AGENT_HANDLING',
}

@Entity('conversations')
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site)
  @JoinColumn({ name: 'siteId' })
  site: Site;

  /** Null until an agent claims the conversation */
  @Column({ type: 'uuid', nullable: true })
  agentId: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'agentId' })
  agent: User | null;

  @Column()
  visitorName: string;

  @Column()
  visitorEmail: string;

  @Column({
    type: 'enum',
    enum: ConversationStatus,
    default: ConversationStatus.OPEN,
  })
  status: ConversationStatus;

  @Column({
    type: 'enum',
    enum: HandlingStatus,
    default: HandlingStatus.WAITING_FOR_AGENT,
  })
  handlingStatus: HandlingStatus;

  /** Used by the gateway and cron job to auto-close idle chats */
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  lastActivityAt: Date;

  @OneToMany(() => ChatMessage, (msg) => msg.conversation)
  messages: ChatMessage[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
