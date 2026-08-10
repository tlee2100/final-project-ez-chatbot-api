import { Module } from '@nestjs/common';
import { AiModerationService } from './moderation/ai-moderation.service';
import { AI_MODERATION_SERVICE } from './interfaces/moderation.interface';

/**
 * SecurityModule – registers all Sprint 2 security providers.
 *
 * Exports:
 * - AI_MODERATION_SERVICE token → AiModerationService (inject by token)
 */
@Module({
  providers: [
    {
      provide: AI_MODERATION_SERVICE,
      useClass: AiModerationService,
    },
  ],
  exports: [AI_MODERATION_SERVICE],
})
export class SecurityModule {}
