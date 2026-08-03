import {
  Body,
  Controller,
  Post,
  Req,
  Res,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import type { AuthRequest } from './types/auth-request.type';
import {
  AccessTokenResponseDto,
  MessageResponseDto,
} from './dto/auth-response.dto';

// Refresh-token cookie hardening:
// - In production the cookie uses the `__Host-` prefix (implies Secure,
//   Path=/, no Domain) so a misconfigured deploy cannot send it over HTTP.
// - `secure` is only set in production so local dev over http://localhost
//   still receives the cookie.
const REFRESH_COOKIE_NAME =
  process.env.NODE_ENV === 'production'
    ? '__Host-refreshToken'
    : 'refreshToken';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
  };
}

@ApiTags('Auth')
@ApiExtraModels(AccessTokenResponseDto, MessageResponseDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Login successful',
    type: AccessTokenResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } =
      await this.authService.login(loginDto);

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());

    return { accessToken };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using httpOnly cookie' })
  @ApiResponse({
    status: 201,
    description: 'Access token refreshed successfully',
    type: AccessTokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const refreshToken = cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      // Throw 401 directly if no token is found in the cookie
      throw new UnauthorizedException('No refresh token found');
    }

    const { accessToken, refreshToken: newRefreshToken } =
      await this.authService.refreshToken(refreshToken);

    res.cookie(REFRESH_COOKIE_NAME, newRefreshToken, refreshCookieOptions());

    return { accessToken };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and clear refresh token' })
  @ApiResponse({
    status: 201,
    description: 'Logout successful',
    type: MessageResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(req.user.id);
    res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
    return { message: 'Logged out successfully' };
  }
}
