import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from './entities/booking.entity';
import { BookingService } from './booking.service';
import { SiteModule } from '../site/site.module';
import { NotificationModule } from '../notification/notification.module';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { BookingService as BookingServiceEntity } from '../site/entities/booking-service.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      SiteBookingConfig,
      BookingResource,
      BookingServiceEntity,
    ]),
    forwardRef(() => SiteModule),
    NotificationModule,
  ],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
