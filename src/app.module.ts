import 'dotenv/config';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from 'src/shared/shared.module';
import { BullModule } from '@nestjs/bull';
import { CoreModule } from 'src/core/core.module';
import { UserModule } from './user/user.module';
import { User } from './user/entities/user.entity';
import { SiteModule } from './site/site.module';
import { Site } from './site/entities/site.entity';
import { AuthModule } from './auth/auth.module';
import { AutomapperModule } from '@automapper/nestjs';
import { classes } from '@automapper/classes';
import { ChatModule } from './chat/chat.module';
import { Conversation } from './chat/entities/conversation.entity';
import { ChatMessage } from './chat/entities/chat-message.entity';
import { DocumentModule } from './document/document.module';
import { Document } from './document/entities/document.entity';
import { OrganizationModule } from './organization/organization.module';
import { Organization } from './organization/entities/organization.entity';
import { NotificationModule } from './notification/notification.module';
import { Notification } from './notification/entities/notification.entity';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      entities: [
        User,
        Site,
        Document,
        Organization,
        Notification,
        Conversation,
        ChatMessage,
      ],
      synchronize: false, // set true for dev, false for prod
    }),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
    }),
    AutomapperModule.forRoot({
      strategyInitializer: classes(),
    }),

    CoreModule,
    SharedModule,
    UserModule,
    SiteModule,
    AuthModule,
    ChatModule,
    DocumentModule,
    OrganizationModule,
    NotificationModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
