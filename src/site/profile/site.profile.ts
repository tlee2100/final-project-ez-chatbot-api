import { createMap, forMember, mapFrom, type Mapper } from '@automapper/core';
import { AutomapperProfile, InjectMapper } from '@automapper/nestjs';
import { Injectable } from '@nestjs/common';
import { SiteDto } from '../dto/site.dto';
import { Site } from '../entities/site.entity';

@Injectable()
export class SiteProfile extends AutomapperProfile {
  /** Default LLM model for master-key sites — read once at startup from env. */
  private readonly defaultLlmModel: string;

  constructor(@InjectMapper() mapper: Mapper) {
    super(mapper);
    this.defaultLlmModel =
      process.env.DEEPSEEK_MODEL || process.env.AI_MODEL || 'qwen3.7-flash';
  }

  override get profile() {
    const defaultLlmModel = this.defaultLlmModel;
    return (mapper: Mapper) => {
      createMap(
        mapper,
        Site,
        SiteDto,
        forMember(
          (d) => d.kbDocuments,
          mapFrom((s) => s.documentIds?.length ?? s.documents?.length ?? 0),
        ),
        forMember(
          (d) => d.hasCustomApiKey,
          mapFrom((s) => Boolean(s.keyMask || s.encryptedOpenAiKey)),
        ),
        forMember(
          (d) => d.customKeyStatus,
          mapFrom((s) => s.customKeyStatus ?? 'unknown'),
        ),
        forMember(
          (d) => d.customBaseUrl,
          mapFrom((s) => s.customBaseUrl ?? null),
        ),
        forMember(
          (d) => d.keyMask,
          mapFrom((s) => s.keyMask ?? null),
        ),
        forMember(
          (d) => d.llmModel,
          // When BYOK is active, expose the site's chosen model.
          // Otherwise, always reflect the master-key env model so the UI stays in sync.
          mapFrom((s) =>
            s.useCustomOpenAiKey && s.llmModel ? s.llmModel : defaultLlmModel,
          ),
        ),
      );
    };
  }
}
