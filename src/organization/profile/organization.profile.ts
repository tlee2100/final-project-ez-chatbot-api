import { createMap, forMember, mapFrom, type Mapper } from '@automapper/core';
import { AutomapperProfile, InjectMapper } from '@automapper/nestjs';
import { Injectable } from '@nestjs/common';
import { OrganizationDto } from '../dto/organization.dto';
import { Organization } from '../entities/organization.entity';

@Injectable()
export class OrganizationProfile extends AutomapperProfile {
  constructor(@InjectMapper() mapper: Mapper) {
    super(mapper);
  }

  override get profile() {
    return (mapper: Mapper) => {
      createMap(
        mapper,
        Organization,
        OrganizationDto,
        forMember(
          (d) => d.owner,
          mapFrom((s) =>
            s.owner
              ? {
                  id: s.owner.id,
                  name: s.owner.name,
                  email: s.owner.email,
                  avatarUrl: s.owner.avatarUrl,
                }
              : null,
          ),
        ),
      );
    };
  }
}
