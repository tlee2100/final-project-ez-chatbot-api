import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatGateway } from './chat.gateway';

@Module({
  imports: [
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
  providers: [ChatGateway],
  exports: [ChatGateway],
})
export class ChatModule {}
