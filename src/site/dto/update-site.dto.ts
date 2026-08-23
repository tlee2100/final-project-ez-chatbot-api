import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutoMap } from '@automapper/classes';
import {
  IsString,
  IsUrl,
  IsOptional,
  IsBoolean,
  IsArray,
  IsInt,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { IsSmallerThan } from './is-smaller-than.validator';

export class UpdateSiteDto {
  @ApiPropertyOptional({ example: 'My Site Updated' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/updated' })
  @IsUrl()
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the AI is active for this site',
  })
  @IsOptional()
  @IsBoolean()
  isAiActive?: boolean;

  @ApiProperty({
    description: 'Allowed domains for the chat widget',
    type: [String],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedDomains?: string[];

  @AutoMap()
  @ApiProperty({ description: 'Max tokens per AI response', required: false })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(4000)
  maxTokensPerResponse?: number;

  @AutoMap(() => String)
  @ApiProperty({
    description: 'Custom system prompt override for the site',
    required: false,
    nullable: true,
  })
  @IsOptional()
  systemPromptOverride?: string | null;

  @AutoMap()
  @ApiProperty({
    description: 'Whether to use current page content',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  useCurrentPageContent?: boolean;

  @AutoMap()
  @ApiProperty({
    description: 'Whether to summarize memory',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  memorySummarization?: boolean;

  @AutoMap()
  @ApiProperty({
    description: 'Whether to perform sentiment detection',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  sentimentDetection?: boolean;

  @AutoMap()
  @ApiPropertyOptional({
    example: 'qwen3.7-flash',
    description: 'LLM Model for the site or null to use shared model',
  })
  @IsOptional()
  @IsString()
  llmModel?: string;

  @AutoMap()
  @ApiPropertyOptional({
    example: 50,
    description: 'Max messages per chat session',
  })
  @IsOptional()
  maxMessagesPerSession?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Max chat sessions per IP in 24h',
  })
  @IsOptional()
  maxSessionsPerIp?: number;

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

  // ── BYOK (SEC-001 / CE-004) ──
  @ApiPropertyOptional({
    description:
      'Toggle whether to use the custom OpenAI key without deleting it',
  })
  @IsOptional()
  @IsBoolean()
  useCustomOpenAiKey?: boolean;

  @ApiPropertyOptional({
    description: 'Validation/runtime operational status of the custom API key',
    enum: ['unknown', 'valid', 'invalid'],
  })
  @IsOptional()
  @IsString()
  customKeyStatus?: 'unknown' | 'valid' | 'invalid';

  @ApiPropertyOptional({
    description: 'Custom AI provider endpoint URL',
  })
  @IsOptional()
  @IsString()
  customBaseUrl?: string;
}
