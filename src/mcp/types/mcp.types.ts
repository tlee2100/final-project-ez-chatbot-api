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

/** A resource (staff member) that is available in a time slot */
export interface AvailableResource {
  resourceId: string;
  resourceName: string;
}

/** Mock available slot shape returned before Phase 1C booking module is live. */
export interface AvailableSlot {
  slotId: string;
  date: string;
  timeSlot: string;
  /** Has a value when the customer has selected a specific staff member */
  resourceId?: string;
  resourceName?: string;
  /** Has a value when the customer selects "No Preference" — an array of all available staff */
  availableResources?: AvailableResource[];
  available: boolean;
}

/** Mock booking result shape returned before Phase 1C booking module is live. */
export interface BookingResult {
  bookingCode: string;
  status: 'confirmed' | 'cancelled';
  customerName: string;
  phone: string;
  date: string;
  timeSlot: string;
  resourceName: string;
  serviceId: string;
  serviceName: string;
  createdAt: string;
}

/** DTO for the /booking/create internal endpoint. */
export interface CreateBookingPayload {
  customerName: string;
  customerEmail?: string;
  phone: string;
  serviceId: string;
  resourceId: string;
  date: string;
  timeSlot: string;
}

export interface SiteConfigServiceItem {
  id: string;
  name: string;
}

export interface SiteConfigResourceItem {
  id: string;
  name: string;
}

export interface SiteConfigBookingHours {
  timezone?: string;
  availableDays?: number[];
  startTime?: string;
  endTime?: string;
  slotDuration?: number;
}
