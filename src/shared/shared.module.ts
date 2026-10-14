import { Module } from '@nestjs/common';
import { RedisModule } from './redis.module';

@Module({
  imports: [RedisModule],
  exports: [RedisModule],
})
export class SharedModule {}
