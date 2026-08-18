import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { Booking } from './entities/booking.entity';
import { BookingService } from './booking.service';
import { BookingGateway } from './booking.gateway';
import { SiteModule } from '../site/site.module';
import { NotificationModule } from '../notification/notification.module';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { BookingService as BookingServiceEntity } from '../site/entities/booking-service.entity';
import { SharedModule } from '../shared/shared.module';

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
    SharedModule,
    (() => {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error(
          'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
        );
      }
      return JwtModule.register({ secret: jwtSecret });
    })(),
  ],
  providers: [BookingService, BookingGateway],
  exports: [BookingService, BookingGateway],
})
export class BookingModule {}
