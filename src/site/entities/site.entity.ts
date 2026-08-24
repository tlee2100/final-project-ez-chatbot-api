import {
  Column,
  Entity,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { AutoMap } from '@automapper/classes';
import { KnowledgeBaseStatus } from '../enums/knowledge-base-status.enum';
import { Document } from '../../document/entities/document.entity';
import { Organization } from '../../organization/entities/organization.entity';
import { CrawlerConfig } from '../../crawler/entities/crawler-config.entity';
import { IndustryTemplate } from './industry-template.entity';
import { SiteBookingConfig } from './site-booking-config.entity';
import { BookingServiceItem } from './booking-service.entity';
import { BookingResource } from './booking-resources.entity';

@Entity('sites')
export class Site {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column()
  name: string;

  @AutoMap()
  @Column()
  url: string;

  @AutoMap()
  @Column({ type: 'uuid', nullable: false })
  ownerId: string;

  @AutoMap(() => User)
  @ManyToOne(() => User, (user) => user.sites)
  @JoinColumn({ name: 'ownerId' })
  owner: User;

  @AutoMap(() => User)
  @ManyToMany(() => User, (user) => user.assignedSites)
  @JoinTable({
    name: 'site_agents',
    joinColumn: {
      name: 'siteId',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'agentId',
      referencedColumnName: 'id',
    },
  })
  agents: User[];

  @AutoMap(() => String)
  @Column({
    type: 'enum',
    enum: KnowledgeBaseStatus,
    default: KnowledgeBaseStatus.READY,
  })
  knowledgeBaseStatus: KnowledgeBaseStatus;

  @AutoMap(() => String)
  @Column({ type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, (org) => org.sites, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'organizationId' })
  organization: Organization;

  @OneToMany(() => Document, (document) => document.site)
  documents: Document[];

  @OneToMany(() => CrawlerConfig, (config) => config.site)
  crawlerConfigs: CrawlerConfig[];

  documentIds?: string[];

  @AutoMap()
  @Column({ name: 'enabled', type: 'boolean', default: true })
  enabled: boolean;

  @AutoMap()
  @Column({ name: 'isAiActive', type: 'boolean', default: true })
  isAiActive: boolean;

  @AutoMap()
  @Column({ name: 'humanHandoff', type: 'boolean', default: false })
  humanHandoff: boolean;

  @AutoMap()
  @Column({ name: 'emailTranscript', type: 'boolean', default: false })
  emailTranscript: boolean;

  @AutoMap(() => [String])
  @Column({ type: 'text', array: true, default: '{}' })
  allowedDomains: string[];

  @AutoMap()
  @Column({ name: 'maxTokensPerResponse', type: 'int', default: 1000 })
  maxTokensPerResponse: number;

  @Column({ type: 'integer', default: 800 })
  kbChunkSize: number;

  @Column({ type: 'integer', default: 100 })
  kbChunkOverlap: number;

  @Column({ type: 'integer', default: 4 })
  kbRetrievalTopK: number;

  @Column({ type: 'double precision', default: 0.5 })
  kbSimilarityThreshold: number;

  @AutoMap(() => String)
  @Column({ name: 'systemPromptOverride', type: 'text', nullable: true })
  systemPromptOverride: string | null;

  @AutoMap()
  @Column({ name: 'useCurrentPageContent', type: 'boolean', default: true })
  useCurrentPageContent: boolean;

  @AutoMap()
  @Column({ name: 'memorySummarization', type: 'boolean', default: true })
  memorySummarization: boolean;

  @AutoMap()
  @Column({ name: 'sentimentDetection', type: 'boolean', default: false })
  sentimentDetection: boolean;

  @AutoMap()
  @Column({ name: 'llmModel', type: 'varchar', default: 'qwen3.7-flash' })
  llmModel: string;

  @AutoMap()
  @Column({ type: 'boolean', default: false })
  bookingEnabled: boolean;

  @AutoMap(() => String)
  @Column({ type: 'varchar', length: 50, default: 'salon' })
  industryTemplateId: string;

  @AutoMap(() => IndustryTemplate)
  @ManyToOne(() => IndustryTemplate, (template) => template.sites, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'industryTemplateId' })
  industryTemplateInfo: IndustryTemplate;

  @AutoMap(() => SiteBookingConfig)
  @OneToOne(() => SiteBookingConfig, (config) => config.site, { cascade: true })
  bookingConfig: SiteBookingConfig;

  @AutoMap(() => [BookingServiceItem])
  @OneToMany(() => BookingServiceItem, (service) => service.site, {
    cascade: true,
  })
  bookingServices: BookingServiceItem[];

  @AutoMap(() => [BookingResource])
  @OneToMany(() => BookingResource, (resource) => resource.site, {
    cascade: true,
  })
  bookingResources: BookingResource[];

  @AutoMap()
  @Column({ name: 'maxMessagesPerSession', type: 'int', default: 50 })
  maxMessagesPerSession: number;

  @AutoMap()
  @Column({ name: 'maxSessionsPerIp', type: 'int', default: 10 })
  maxSessionsPerIp: number;

  @AutoMap()
  @Column({
    name: 'enableConversationTimeout',
    type: 'boolean',
    default: false,
  })
  enableConversationTimeout: boolean;

  @AutoMap()
  @Column({ name: 'inactivityTimeoutMinutes', type: 'int', default: 15 })
  inactivityTimeoutMinutes: number;

  @AutoMap()
  @Column({ name: 'warningTimeMinutes', type: 'int', default: 5 })
  warningTimeMinutes: number;

  @AutoMap()
  @Column({ name: 'inactivityWarningMessage', type: 'text', nullable: true })
  inactivityWarningMessage: string;

  @AutoMap()
  @Column({ name: 'timeoutMessage', type: 'text', nullable: true })
  timeoutMessage: string;

  @AutoMap()
  @Column({ name: 'resetTimerOnBotResponse', type: 'boolean', default: true })
  resetTimerOnBotResponse: boolean;

  @AutoMap()
  @Column({ name: 'pauseTimerForAgentChats', type: 'boolean', default: true })
  pauseTimerForAgentChats: boolean;

  @AutoMap()
  @Column({
    name: 'sendEmailNotificationOnTimeout',
    type: 'boolean',
    default: false,
  })
  sendEmailNotificationOnTimeout: boolean;

  // ── Appearance Settings ──

  @AutoMap(() => String)
  @Column({ name: 'primaryColor', type: 'varchar', nullable: true })
  primaryColor: string | null;

  @AutoMap(() => String)
  @Column({ name: 'backgroundColor', type: 'varchar', nullable: true })
  backgroundColor: string | null;

  @AutoMap(() => String)
  @Column({ name: 'botAvatar', type: 'text', nullable: true })
  botAvatar: string | null;

  @AutoMap(() => String)
  @Column({ name: 'launcherIcon', type: 'text', nullable: true })
  launcherIcon: string | null;

  @AutoMap(() => String)
  @Column({ name: 'defaultGreetingMessage', type: 'text', nullable: true })
  defaultGreetingMessage: string | null;

  @AutoMap(() => String)
  @Column({
    name: 'chatButtonPosition',
    type: 'varchar',
    default: 'Bottom Right',
  })
  chatButtonPosition: string;

  @AutoMap(() => String)
  @Column({ name: 'chatWindowTitle', type: 'varchar', nullable: true })
  chatWindowTitle: string | null;

  @AutoMap(() => String)
  @Column({ name: 'chatButtonText', type: 'varchar', nullable: true })
  chatButtonText: string | null;

  @AutoMap(() => Boolean)
  @Column({ name: 'showAvatar', type: 'boolean', default: true })
  showAvatar: boolean;

  // ── BYOK — Bring Your Own Key (SEC-001 / CE-004) ──

  /**
   * When true, use the site's own encrypted OpenAI key instead of the master env key.
   * The key is stored encrypted via AES-256-GCM in encryptedOpenAiKey.
   */
  @AutoMap(() => Boolean)
  @Column({ name: 'useCustomOpenAiKey', type: 'boolean', default: false })
  useCustomOpenAiKey: boolean;

  /**
   * AES-256-GCM encrypted OpenAI API key. Format: "<iv>:<authTag>:<ciphertext>" (hex).
   * NEVER returned to the client — only decrypted inside the AI proxy layer.
   */
  @Column({ name: 'encryptedOpenAiKey', type: 'text', nullable: true })
  encryptedOpenAiKey: string | null;

  /**
   * Validation and runtime operational status of the custom key.
   * 'valid': verified & working.
   * 'invalid': rejected/unauthorized/insufficient quota.
   * 'unknown': unverified or untested.
   */
  @AutoMap(() => String)
  @Column({
    name: 'customKeyStatus',
    type: 'varchar',
    length: 20,
    default: 'unknown',
  })
  customKeyStatus: 'unknown' | 'valid' | 'invalid';

  /**
   * Custom AI provider endpoint URL (optional).
   * If not set, falls back to server env DEEPSEEK_BASE_URL / OPENAI_BASE_URL.
   */
  @AutoMap(() => String)
  @Column({
    name: 'customBaseUrl',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  customBaseUrl: string | null;

  /**
   * Masked representation of the custom API key for safe UI display (e.g. "sk-proj-****...3a9b").
   */
  @AutoMap(() => String)
  @Column({ name: 'keyMask', type: 'varchar', length: 60, nullable: true })
  keyMask: string | null;
}
