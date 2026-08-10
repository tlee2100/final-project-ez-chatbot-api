import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { IAIModerationService } from '../interfaces/moderation.interface';

/**
 * AI Content Filtering (2-Layer Defense)
 *
 * Layer 1 – Local Regex (Fast Path, ~0ms):
 *   Blocks obvious prompt-injection patterns before touching the network.
 *
 * Layer 2 – OpenAI Moderation API (Slow Path, ~100-300ms):
 *   Calls the free `/v1/moderations` endpoint to detect hate, violence,
 *   self-harm, sexual, and harassment content.
 */
@Injectable()
export class AiModerationService implements IAIModerationService {
  private readonly logger = new Logger(AiModerationService.name);
  private readonly client: OpenAI;

  /**
   * Prompt-injection patterns (Layer 1 — local regex fast-path).
   * These are common jailbreak/injection attack phrases.
   */
  private readonly INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
    /you\s+are\s+now\s+(a\s+)?(\w+\s+)?(DAN|jailbroken|uncensored)/i,
    /forget\s+(everything|all|your)\s+(you\s+know|instructions?|training)/i,
    /act\s+as\s+(if\s+)?(you\s+(are|were)\s+)?(a\s+)?(DAN|evil|uncensored)/i,
    /system\s*:\s*you\s+are/i,
    /\[SYSTEM\]/i,
    /<\s*system\s*>/i,
  ];

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async isSafe(content: string): Promise<boolean> {
    // ── Layer 1: Local Regex Fast-Path ──────────────────────────────────────
    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        this.logger.warn(
          `Prompt injection detected by regex — pattern: ${pattern.source.slice(0, 60)}`,
        );
        return false;
      }
    }

    // ── Layer 2: OpenAI Moderation API Slow-Path ────────────────────────────
    try {
      const result = await this.client.moderations.create({
        model: 'omni-moderation-latest',
        input: content,
      });

      const flagged = result.results[0]?.flagged ?? false;
      if (flagged) {
        const categories = result.results[0]?.categories ?? {};
        const triggered = Object.entries(categories)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ');
        this.logger.warn(
          `Content flagged by OpenAI Moderation API — categories: ${triggered}`,
        );
      }

      return !flagged;
    } catch (err) {
      // If the Moderation API is unavailable, fail-open (allow) but log a warning.
      // Adjust to fail-closed (return false) if stricter safety is required.
      this.logger.error(
        `OpenAI Moderation API error — failing open: ${err instanceof Error ? err.message : String(err)}`,
      );
      return true;
    }
  }
}
