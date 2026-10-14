/**
 * Contract for the AI content moderation service.
 * Two-layer defense: local regex fast-path + OpenAI Moderation API slow-path.
 */
export interface IAIModerationService {
  /**
   * Checks the content against both layers.
   * @returns true if the content is SAFE, false if it should be BLOCKED.
   */
  isSafe(content: string): Promise<boolean>;
}

export const AI_MODERATION_SERVICE = Symbol('AI_MODERATION_SERVICE');
