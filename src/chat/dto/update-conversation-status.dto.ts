import { IsEnum, IsOptional } from 'class-validator';
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
  transcriptEmail?: string;
}
