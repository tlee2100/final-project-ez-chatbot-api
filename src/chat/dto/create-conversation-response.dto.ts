import {
  ConversationStatus,
  HandlingStatus,
} from '../entities/conversation.entity';

/**
 * Response DTO for the POST /chat/conversations endpoint.
 *
 * Intentionally exposes only the fields the visitor's chat widget needs to
 * bootstrap the session. Sensitive fields (agentId, summary, etc.) are excluded.
 */
export class CreateConversationResponseDto {
  conversationId: string;
  siteId: string;
  visitorName: string;
  visitorEmail: string | null;
  status: ConversationStatus;
  handlingStatus: HandlingStatus;
  visitorToken?: string;
}
