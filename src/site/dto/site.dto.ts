import { AutoMap } from '@automapper/classes';
import { ApiProperty } from '@nestjs/swagger';
import { KnowledgeBaseStatus } from '../enums/knowledge-base-status.enum';
import { UserDto } from '../../user/dto/user.dto';

export class SiteDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Site ID',
  })
  @AutoMap()
  id: string;

  @ApiProperty({
    example: 'Zodinet',
    description: 'Site name',
  })
  @AutoMap()
  name: string;

  @ApiProperty({
    example: 'https://zodinet.com',
    description: 'Site URL',
  })
  @AutoMap()
  url: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Owner user ID',
  })
  @AutoMap()
  ownerId: string;

  @ApiProperty({
    enum: KnowledgeBaseStatus,
    example: KnowledgeBaseStatus.PENDING,
    description: 'Knowledge base processing status',
  })
  @AutoMap(() => String)
  knowledgeBaseStatus: KnowledgeBaseStatus;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Organization ID',
    nullable: true,
  })
  @AutoMap(() => String)
  organizationId: string | null;

  @ApiProperty({
    example: 5,
    description: 'Number of knowledge base documents',
  })
  @AutoMap()
  kbDocuments: number;

  @ApiProperty({
    example: 2,
    description: 'Number of active chats',
  })
  activeChats: number;

  @ApiProperty({
    example: true,
    description: 'Whether the AI is active for this site',
  })
  @AutoMap()
  isAiActive: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether the site is enabled (alias for isAiActive)',
  })
  enabled: boolean;

  @ApiProperty({
    example: '2026-08-13T00:00:00.000Z',
    description: 'Updated timestamp',
  })
  updatedAt: string;

  @ApiProperty({
    description: 'Assigned agents for this site',
    type: () => [UserDto],
    nullable: true,
  })
  @AutoMap(() => UserDto)
  agents?: UserDto[];

  @ApiProperty({
    type: [String],
    description:
      'Allowed domains for the chat widget (e.g., example.com, *.example.com)',
    example: ['example.com', '*.example.com'],
  })
  @AutoMap(() => [String])
  allowedDomains: string[];

  @AutoMap()
  @ApiProperty({ description: 'Max tokens per AI response', default: 1000 })
  maxTokensPerResponse: number;

  @AutoMap(() => String)
  @ApiProperty({
    description: 'Custom system prompt override for the site',
    nullable: true,
  })
  systemPromptOverride: string | null;

  @AutoMap()
  @ApiProperty({
    description: 'Whether to use current page content',
    default: true,
  })
  useCurrentPageContent: boolean;

  @AutoMap()
  @ApiProperty({ description: 'Whether to summarize memory', default: true })
  memorySummarization: boolean;

  @AutoMap()
  @ApiProperty({
    description: 'Whether to perform sentiment detection',
    default: false,
  })
  sentimentDetection: boolean;

  @ApiProperty({
    example: 50,
    description: 'Max messages per chat session',
  })
  @AutoMap()
  maxMessagesPerSession: number;

  @ApiProperty({
    example: 10,
    description: 'Max chat sessions per IP in 24h',
  })
  @AutoMap()
  maxSessionsPerIp: number;

  @ApiProperty({
    example: false,
    description: 'Enable automatic conversation timeout',
  })
  @AutoMap()
  enableConversationTimeout: boolean;

  @ApiProperty({
    example: 15,
    description: 'Inactivity timeout in minutes before closing conversation',
  })
  @AutoMap()
  inactivityTimeoutMinutes: number;

  @ApiProperty({
    example: 5,
    description: 'Warning time in minutes before timeout',
  })
  @AutoMap()
  warningTimeMinutes: number;

  @ApiProperty({
    example: 'Are you still there?',
    description: 'Message sent when warning time is reached',
    nullable: true,
  })
  @AutoMap()
  inactivityWarningMessage: string;

  @ApiProperty({
    example: 'Conversation closed due to inactivity.',
    description: 'Message sent when conversation times out',
    nullable: true,
  })
  @AutoMap()
  timeoutMessage: string;

  @ApiProperty({
    example: true,
    description: 'Reset inactivity timer on bot response',
  })
  @AutoMap()
  resetTimerOnBotResponse: boolean;

  @ApiProperty({
    example: true,
    description: 'Pause inactivity timer for agent-assigned chats',
  })
  @AutoMap()
  pauseTimerForAgentChats: boolean;

  @ApiProperty({
    example: false,
    description: 'Send email notification on timeout',
  })
  @AutoMap()
  sendEmailNotificationOnTimeout: boolean;

  // ── Appearance Settings ──

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  primaryColor: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  backgroundColor: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  botAvatar: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  launcherIcon: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  defaultGreetingMessage: string | null;

  @ApiProperty({ default: 'Bottom Right' })
  @AutoMap(() => String)
  chatButtonPosition: string;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  chatWindowTitle: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  chatButtonText: string | null;

  @ApiProperty({ default: true })
  @AutoMap(() => Boolean)
  showAvatar: boolean;
}
