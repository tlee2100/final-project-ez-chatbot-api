import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';
import { Notification } from './entities/notification.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    (() => {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error(
          'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
        );
      }
      return JwtModule.register({
        secret: jwtSecret,
      });
    })(),
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationGateway],
  exports: [NotificationService, NotificationGateway],
})
export class NotificationModule {}
