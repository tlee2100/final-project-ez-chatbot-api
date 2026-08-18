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

export enum ClosedReason {
  VISITOR = 'VISITOR',
  TIMEOUT = 'TIMEOUT',
  AGENT = 'AGENT',
  ERROR = 'ERROR',
  CLEARED = 'CLEARED',
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
    default: HandlingStatus.AI_HANDLING,
  })
  handlingStatus: HandlingStatus;

  @Column({
    type: 'enum',
    enum: ClosedReason,
    nullable: true,
  })
  closedReason: ClosedReason | null;

  /** Used by the gateway and cron job to auto-close idle chats */
  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  lastActivityAt: Date;

  /**
   * Rolling summary of the conversation produced by the LangGraph summarize_memory node.
   * Used to condense old messages into a compact context window for the LLM.
   */
  @Column({ type: 'text', nullable: true, default: null })
  summary: string | null;

  /**
   * Number of messages that have already been summarized and compacted.
   * Tracked so the graph knows which portion of the history is already captured in `summary`.
   */
  @Column({ type: 'integer', default: 0 })
  summarizedMessageCount: number;

  @Column({ type: 'boolean', default: false })
  hasNegativeSentiment: boolean;

  /**
   * Conversation-level AI active flag.
   * Starts as `true` for every new conversation (AI handles it).
   * Flips to `false` when a human agent takes over (`joinConversation`).
   * Independent of the site-level `site.isAiActive` toggle — both must be true
   * for the AgentService to invoke the LangGraph workflow.
   */
  @Column({ type: 'boolean', default: true })
  isAiActive: boolean;

  @OneToMany(() => ChatMessage, (msg) => msg.conversation)
  messages: ChatMessage[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
