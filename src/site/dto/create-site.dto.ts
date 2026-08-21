import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  IsBoolean,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { IsSmallerThan } from './is-smaller-than.validator';

export class CreateSiteDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Agent user IDs assigned to this site',
    example: ['b2d5f8d5-2f35-4c76-8d84-123456789abc'],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  agentIds?: string[];

  @ApiPropertyOptional({
    description:
      'Organization to own this site (SUPER_ADMIN only; ADMIN is always forced to their own organization)',
  })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the site is enabled for embedding',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the AI is active for this site',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAiActive?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether human handoff is enabled',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  humanHandoff?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Whether email transcript is enabled',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  emailTranscript?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Allowed domains for the chat widget (e.g., example.com, *.example.com)',
    example: ['example.com', '*.example.com'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'Enable automatic conversation timeout',
  })
  @IsOptional()
  @IsBoolean()
  enableConversationTimeout?: boolean;

  @ApiPropertyOptional({
    example: 15,
    description: 'Inactivity timeout in minutes before closing conversation',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(60)
  inactivityTimeoutMinutes?: number;

  @ApiPropertyOptional({
    example: 5,
    description: 'Warning time in minutes before timeout',
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  @IsSmallerThan('inactivityTimeoutMinutes', {
    message:
      'warningTimeMinutes must be strictly less than inactivityTimeoutMinutes',
  })
  warningTimeMinutes?: number;

  @ApiPropertyOptional({
    example: 'Are you still there?',
    description: 'Message sent when warning time is reached',
  })
  @IsOptional()
  @IsString()
  inactivityWarningMessage?: string;

  @ApiPropertyOptional({
    example: 'Conversation closed due to inactivity.',
    description: 'Message sent when conversation times out',
  })
  @IsOptional()
  @IsString()
  timeoutMessage?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Reset inactivity timer on bot response',
  })
  @IsOptional()
  @IsBoolean()
  resetTimerOnBotResponse?: boolean;

  @ApiPropertyOptional({
    example: true,
    description: 'Pause inactivity timer for agent-assigned chats',
  })
  @IsOptional()
  @IsBoolean()
  pauseTimerForAgentChats?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Send email notification on timeout',
  })
  @IsOptional()
  @IsBoolean()
  sendEmailNotificationOnTimeout?: boolean;

  // ── Appearance Settings ──

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  primaryColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  backgroundColor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  botAvatar?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  launcherIcon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultGreetingMessage?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chatButtonPosition?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chatWindowTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chatButtonText?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  showAvatar?: boolean;
}
