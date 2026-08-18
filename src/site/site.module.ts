import { Module, forwardRef } from '@nestjs/common';
import { SiteController } from './site.controller';
import { SiteService } from './site.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Site } from './entities/site.entity';
import { SiteProfile } from './profile/site.profile';
import { AdminBookingController } from './admin-booking.controller';
import { AdminBookingService } from './admin-booking.service';
import { NotificationModule } from '../notification/notification.module';
import { BookingResource } from './entities/booking-resources.entity';
import { BookingService } from './entities/booking-service.entity';
import { SiteBookingConfig } from './entities/site-booking-config.entity';
import { BookingModule } from '../booking/booking.module';
import { ChatModule } from '../chat/chat.module';
import { Booking } from '../booking/entities/booking.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Site,
      User,
      BookingResource,
      BookingService,
      SiteBookingConfig,
      Booking,
    ]),
    NotificationModule,
    forwardRef(() => BookingModule),
    forwardRef(() => ChatModule),
  ],
  controllers: [SiteController, AdminBookingController],
  providers: [SiteService, SiteProfile, AdminBookingService],
  exports: [SiteService],
})
export class SiteModule {}
