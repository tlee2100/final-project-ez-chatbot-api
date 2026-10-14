import { IsEnum, IsOptional, IsString } from 'class-validator';
import {
  ConversationStatus,
  ClosedReason,
} from '../entities/conversation.entity';

export class UpdateConversationStatusDto {
  @IsEnum(ConversationStatus)
  status: ConversationStatus;

  @IsOptional()
  @IsEnum(ClosedReason)
  reason?: ClosedReason;

  @IsOptional()
  @IsString()
  transcriptEmail?: string;

  @IsOptional()
  @IsString()
  siteId?: string;
}
