import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { MailerModule } from '@nestjs-modules/mailer';
import { BullModule } from '@nestjs/bull';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';
import { Notification } from './entities/notification.entity';
import { getMailerConfig } from './config/mailer.config';
import { EmailProcessor } from './processors/email.processor';
import { EmailQueueService } from './email-queue.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification]),
    BullModule.registerQueue({ name: 'email-queue' }),
    MailerModule.forRoot(getMailerConfig()),
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
  providers: [
    NotificationService,
    NotificationGateway,
    EmailQueueService,
    EmailProcessor,
  ],
  exports: [NotificationService, NotificationGateway, EmailQueueService],
})
export class NotificationModule {}
