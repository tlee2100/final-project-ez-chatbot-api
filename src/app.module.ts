import 'dotenv/config';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SharedModule } from 'src/shared/shared.module';
import { BullModule } from '@nestjs/bull';
import { CoreModule } from 'src/core/core.module';
import { UserModule } from './user/user.module';
import { User } from './user/entities/user.entity';
import { SiteModule } from './site/site.module';
import { Site } from './site/entities/site.entity';
import { SiteBookingConfig } from './site/entities/site-booking-config.entity';
import { BookingServiceItem } from './site/entities/booking-service.entity';
import { BookingResource } from './site/entities/booking-resources.entity';
import { IndustryTemplate } from './site/entities/industry-template.entity';
import { Booking } from './booking/entities/booking.entity';
import { BookingBlockout } from './booking/entities/booking-blockout.entity';
import { BookingModule } from './booking/booking.module';
import { AuthModule } from './auth/auth.module';
import { AutomapperModule } from '@automapper/nestjs';
import { classes } from '@automapper/classes';
import { ChatModule } from './chat/chat.module';
import { Conversation } from './chat/entities/conversation.entity';
import { ChatMessage } from './chat/entities/chat-message.entity';
import { DocumentModule } from './document/document.module';
import { Document } from './document/entities/document.entity';
import { DocumentChunk } from './document/entities/document-chunk.entity';
import { OrganizationModule } from './organization/organization.module';
import { Organization } from './organization/entities/organization.entity';
import { NotificationModule } from './notification/notification.module';
import { Notification } from './notification/entities/notification.entity';
import { AnalyticsModule } from './analytics/analytics.module';
import { McpModule } from './mcp/mcp.module';
import { ThrottlerModule } from '@nestjs/throttler';
import { SecurityModule } from './security/security.module';
import { CrawlerModule } from './crawler/crawler.module';
import { CrawlerConfig } from './crawler/entities/crawler-config.entity';
import { CrawlRun } from './crawler/entities/crawl-run.entity';
import { CrawlRunItem } from './crawler/entities/crawl-run-item.entity';

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
        SiteBookingConfig,
        BookingServiceItem,
        BookingResource,
        IndustryTemplate,
        Booking,
        BookingBlockout,
        Document,
        DocumentChunk,
        Organization,
        Notification,
        Conversation,
        ChatMessage,
        CrawlerConfig,
        CrawlRun,
        CrawlRunItem,
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

    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 60_000, // 1 minute
        limit: 120, // 120 requests per minute
      },
    ]),
    ScheduleModule.forRoot(),
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
    BookingModule,
    McpModule,
    SecurityModule,
    CrawlerModule,
  ],
})
export class AppModule {}
