import { createMap, forMember, mapFrom, type Mapper } from '@automapper/core';
import { AutomapperProfile, InjectMapper } from '@automapper/nestjs';
import { Injectable } from '@nestjs/common';
import { SiteDto } from '../dto/site.dto';
import { Site } from '../entities/site.entity';

@Injectable()
export class SiteProfile extends AutomapperProfile {
  constructor(@InjectMapper() mapper: Mapper) {
    super(mapper);
  }

  override get profile() {
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
          (d) => d.enabled,
          mapFrom((s) => s.isAiActive),
        ),
      );
    };
  }
}
