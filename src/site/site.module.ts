import { Module } from '@nestjs/common';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Site } from './entities/site.entity';
import { SiteProfile } from './profile/site.profile';

@Module({
  imports: [TypeOrmModule.forFeature([Site, User])],
  controllers: [SiteController],
  providers: [SiteService, SiteProfile],
})
export class SiteModule {}
