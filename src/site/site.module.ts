import { Module, forwardRef } from '@nestjs/common';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Site } from './entities/site.entity';
import { SiteProfile } from './profile/site.profile';
import { NotificationModule } from '../notification/notification.module';
import { BookingResource } from './entities/booking-resources.entity';
import { BookingServiceItem } from './entities/booking-service.entity';
import { SiteBookingConfig } from './entities/site-booking-config.entity';
import { BookingModule } from '../booking/booking.module';
import { ChatModule } from '../chat/chat.module';
import { Document } from '../document/entities/document.entity';
import { CrawlerModule } from '../crawler/crawler.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Site,
      User,
      BookingResource,
      BookingServiceItem,
      SiteBookingConfig,
      Document,
    ]),
    NotificationModule,
    forwardRef(() => BookingModule),
    forwardRef(() => ChatModule),
    forwardRef(() => CrawlerModule),
  ],
  controllers: [SiteController],
  providers: [SiteService, SiteProfile],
  exports: [SiteService],
})
export class SiteModule {}
