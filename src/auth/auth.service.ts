import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserService } from '../user/user.service';
import { LoginDto } from './dto/login.dto';
import { User } from 'src/user/entities/user.entity';
import { StringValue } from 'ms';
import { ActivateAccountDto } from './dto/activate-account.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
  ) {}

  private generateAccessToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId ?? null,
    };

    return this.jwtService.sign(payload);
  }

  async login(loginDto: LoginDto) {
    const user = await this.userService.findByEmailWithPassword(loginDto.email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account activation is required');
    }

    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = this.generateAccessToken(user);
    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      {
        expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as StringValue,
      },
    );

    await this.userService.updateInternal(user.id, { refreshToken });

    return {
      accessToken,
      refreshToken,
    };
  }

  async refreshToken(token: string) {
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token);
      const user = await this.userService.findByIdWithRefreshToken(payload.sub);

      if (!user) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const now = new Date();
      const isCurrentToken = user.refreshToken === token;
      const isGracePeriodToken =
        user.previousRefreshToken === token &&
        user.previousRefreshTokenExpiresAt !== null &&
        new Date(user.previousRefreshTokenExpiresAt) > now;

      if (!isCurrentToken && !isGracePeriodToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const accessToken = this.generateAccessToken(user);

      if (isGracePeriodToken && user.refreshToken) {
        return {
          accessToken,
          refreshToken: user.refreshToken,
        };
      }

      const newRefreshToken = this.jwtService.sign(
        { sub: user.id },
        {
          expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN ||
            '7d') as StringValue,
        },
      );

      await this.userService.updateInternal(user.id, {
        refreshToken: newRefreshToken,
        previousRefreshToken: token,
        previousRefreshTokenExpiresAt: new Date(Date.now() + 30 * 1000),
      });

      return {
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string) {
    await this.userService.updateInternal(userId, {
      refreshToken: null,
      previousRefreshToken: null,
      previousRefreshTokenExpiresAt: null,
    });
    return { message: 'Logged out successfully' };
  }

  async activateAccount(dto: ActivateAccountDto) {
    return this.userService.activateAccount(dto);
  }

  async validateActivationToken(token: string) {
    return this.userService.validateActivationToken(token);
  }
}
