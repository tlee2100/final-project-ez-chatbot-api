import { IsEnum } from 'class-validator';
import { ConversationStatus } from '../entities/conversation.entity';

export class UpdateConversationStatusDto {
  @IsEnum(ConversationStatus)
  status: ConversationStatus;
}
