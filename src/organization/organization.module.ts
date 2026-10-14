import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import { Organization } from './entities/organization.entity';
import { OrganizationController } from './organization.controller';
import { OrganizationProfile } from './profile/organization.profile';
import { OrganizationService } from './organization.service';

@Module({
  imports: [TypeOrmModule.forFeature([Organization, User, Site])],
  controllers: [OrganizationController],
  providers: [OrganizationService, OrganizationProfile],
  exports: [OrganizationService],
})
export class OrganizationModule {}
