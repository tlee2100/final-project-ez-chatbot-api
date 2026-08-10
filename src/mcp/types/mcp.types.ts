/** Types shared across the MCP internal module. */

/**
 * The validated context decoded from the X-MCP-Context signed header.
 * Populated by the MCP server's auth validate endpoint and passed back
 * through headers on every subsequent internal API call.
 */
export interface McpValidatedContext {
  /** The siteId this session belongs to — never exposed to the LLM. */
  siteId: string;
  /** The conversation ID for this session. */
  conversationId: string;
  /** Actor type and identifier — service account credentials. */
  authorizedActor: {
    type: 'service';
    id: number;
  };
  /** Unix timestamp (seconds) when the session expires. Optional. */
  expiresAt?: number;
}

/** Mock available slot shape returned before Phase 1C booking module is live. */
export interface AvailableSlot {
  slotId: string;
  date: string;
  timeSlot: string;
  resourceId: string;
  resourceName: string;
  available: boolean;
}

/** Mock booking result shape returned before Phase 1C booking module is live. */
export interface BookingResult {
  bookingCode: string;
  status: 'confirmed' | 'cancelled';
  customerName: string;
  date: string;
  timeSlot: string;
  resourceName: string;
  serviceId: string;
  createdAt: string;
}

/** DTO for the /booking/create internal endpoint. */
export interface CreateBookingPayload {
  customerName: string;
  customerEmail?: string;
  phone: string;
  serviceId: string;
  resourceId?: string;
  date: string;
  timeSlot: string;
}
