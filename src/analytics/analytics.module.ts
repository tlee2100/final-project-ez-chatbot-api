import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../chat/entities/conversation.entity';
import { Site } from '../site/entities/site.entity';
import { User } from '../user/entities/user.entity';
import { Organization } from '../organization/entities/organization.entity';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  imports: [TypeOrmModule.forFeature([Conversation, Site, User, Organization])],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
