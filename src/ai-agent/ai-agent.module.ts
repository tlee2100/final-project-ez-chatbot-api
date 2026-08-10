import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AiAgentService } from './ai-agent.service';

@Module({
  imports: [
    (() => {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error('Missing JWT_SECRET environment variable');
      }
      return JwtModule.register({ secret: jwtSecret });
    })(),
  ],
  providers: [AiAgentService],
  exports: [AiAgentService],
})
export class AiAgentModule {}
