import {
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
  Get,
  Query,
} from '@nestjs/common';
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
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ActivateAccountDto } from './dto/activate-account.dto';

@ApiTags('Auth')
@ApiExtraModels(AccessTokenResponseDto, MessageResponseDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('activate-account')
  @ApiOperation({ summary: 'Activate an account and set its password' })
  @ApiBody({ type: ActivateAccountDto })
  @ApiResponse({ status: 201, description: 'Account activated successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid or expired activation token',
  })
  activateAccount(@Body() dto: ActivateAccountDto) {
    return this.authService.activateAccount(dto);
  }

  @Get('validate-activation-token')
  @ApiOperation({ summary: 'Validate an activation token' })
  @ApiResponse({ status: 200, description: 'Token is valid' })
  @ApiResponse({
    status: 404,
    description: 'Token is invalid or expired',
  })
  validateActivationToken(@Query('token') token: string) {
    return this.authService.validateActivationToken(token);
  }

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
  async login(@Body() loginDto: LoginDto) {
    const { accessToken, refreshToken } =
      await this.authService.login(loginDto);

    return { accessToken, refreshToken };
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using httpOnly cookie' })
  @ApiResponse({
    status: 201,
    description: 'Access token refreshed successfully',
    type: AccessTokenResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  @ApiBody({ type: RefreshTokenDto })
  async refresh(@Body() body: RefreshTokenDto) {
    const { accessToken, refreshToken: newRefreshToken } =
      await this.authService.refreshToken(body.refreshToken);

    return { accessToken, refreshToken: newRefreshToken };
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
  async logout(@Req() req: AuthRequest) {
    await this.authService.logout(req.user.id);
    return { message: 'Logged out successfully' };
  }
}
