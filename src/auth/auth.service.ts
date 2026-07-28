import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { authenticator } from '@otplib/preset-v11';
import * as QRCode from 'qrcode';
import { UserService } from '../user/user.service';
import { LoginDto } from './dto/login.dto';
import { User } from 'src/user/entities/user.entity';
import { RecaptchaService } from './recaptcha.service';

const TWO_FACTOR_SECRET = 'XDQXYCP5AC6FA32FQXDGJSPBIZODINET';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly recaptchaService: RecaptchaService,
  ) {}

  private generateAccessToken(user: User): string {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };

    return this.jwtService.sign(payload);
  }

  async login(loginDto: LoginDto) {
    await this.recaptchaService.verify(loginDto.recaptchaToken);

    const user = await this.userService.findByEmail(loginDto.email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.twoFactorEnabled) {
      return {
        requires2FA: true,
        userId: user.id,
        message: '2FA required',
      };
    }

    return {
      accessToken: this.generateAccessToken(user),
    };
  }

  async setup2fa(userId: string) {
    const user = await this.userService.findById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const secret = TWO_FACTOR_SECRET;

    const otpauthUrl = authenticator.keyuri(user.email, 'Chatbot API', secret);

    const qrCodeUrl = await QRCode.toDataURL(otpauthUrl);

    return {
      secret,
      qrCodeUrl,
    };
  }

  async confirm2fa(userId: string, token: string) {
    const user = await this.userService.findById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isValid = authenticator.verify({
      token,
      secret: TWO_FACTOR_SECRET,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    await this.userService.update(userId, {
      twoFactorEnabled: true,
      twoFactorSecret: TWO_FACTOR_SECRET,
    });

    return {
      message: '2FA enabled successfully',
    };
  }

  async disable2fa(userId: string, token: string) {
    const user = await this.userService.findById(userId);

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new UnauthorizedException('2FA is not enabled');
    }

    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    await this.userService.update(userId, {
      twoFactorEnabled: false,
      twoFactorSecret: null,
    });

    return {
      message: '2FA disabled successfully',
    };
  }

  async verify2faLogin(userId: string, token: string) {
    const user = await this.userService.findById(userId);

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new UnauthorizedException('2FA is not enabled');
    }

    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    return {
      accessToken: this.generateAccessToken(user),
    };
  }
}
