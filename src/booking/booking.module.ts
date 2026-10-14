import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Booking } from './entities/booking.entity';
import { BookingBlockout } from './entities/booking-blockout.entity';
import { BookingService } from './booking.service';
import { BookingGateway } from './booking.gateway';
import { AdminBookingController } from './admin-booking.controller';
import { AdminBookingService } from './admin-booking.service';
import { SiteModule } from '../site/site.module';
import { NotificationModule } from '../notification/notification.module';
import { Site } from '../site/entities/site.entity';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { BookingServiceItem } from '../site/entities/booking-service.entity';
import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Booking,
      BookingBlockout,
      SiteBookingConfig,
      BookingResource,
      BookingServiceItem,
      Site,
    ]),
    forwardRef(() => SiteModule),
    NotificationModule,
    SharedModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error(
            'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
          );
        }
        return { secret: jwtSecret };
      },
    }),
  ],
  controllers: [AdminBookingController],
  providers: [BookingService, BookingGateway, AdminBookingService],
  exports: [BookingService, BookingGateway, AdminBookingService],
})
export class BookingModule {}
