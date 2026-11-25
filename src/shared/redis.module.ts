import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { resolveRedisConnectionOptions } from './connection-options';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        return new Redis(resolveRedisConnectionOptions());
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
