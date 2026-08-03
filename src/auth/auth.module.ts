import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from 'src/user/user.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { StringValue } from 'ms';
import { User } from 'src/user/entities/user.entity';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [
    UserModule,
    PassportModule,
    (() => {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error(
          'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
        );
      }

      // Access tokens are stateless (no server-side revocation on logout /
      // role change), so keep the lifetime short. Override via JWT_EXPIRES_IN.
      return JwtModule.register({
        secret: jwtSecret,
        signOptions: {
          expiresIn: (process.env.JWT_EXPIRES_IN || '15m') as StringValue,
        },
      });
    })(),
    TypeOrmModule.forFeature([User]),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
})
export class AuthModule {}
