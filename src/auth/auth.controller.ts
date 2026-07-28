import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { TwoFactorCodeDto } from './dto/two-factor.dto';
import { Verify2faLoginDto } from './dto/verify-2fa-login.dto';
import type { AuthRequest } from './types/auth-request.type';
import {
  AccessTokenResponseDto,
  LoginTwoFactorRequiredResponseDto,
  MessageResponseDto,
  SetupTwoFactorResponseDto,
} from './dto/auth-response.dto';

@ApiTags('Auth')
@ApiExtraModels(
  AccessTokenResponseDto,
  LoginTwoFactorRequiredResponseDto,
  MessageResponseDto,
  SetupTwoFactorResponseDto,
)
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Login successful or 2FA required',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AccessTokenResponseDto) },
        { $ref: getSchemaPath(LoginTwoFactorRequiredResponseDto) },
      ],
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('setup-2fa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate 2FA setup QR code and secret' })
  @ApiResponse({
    status: 201,
    description: '2FA setup data generated successfully',
    type: SetupTwoFactorResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  setup2fa(@Req() req: AuthRequest) {
    return this.authService.setup2fa(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('confirm-2fa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm and enable 2FA' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({
    status: 201,
    description: '2FA enabled successfully',
    type: MessageResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid 2FA code' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  confirm2fa(@Req() req: AuthRequest, @Body() body: TwoFactorCodeDto) {
    return this.authService.confirm2fa(req.user.id, body.token);
  }

  @UseGuards(JwtAuthGuard)
  @Post('disable-2fa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Disable 2FA' })
  @ApiBody({ type: TwoFactorCodeDto })
  @ApiResponse({
    status: 201,
    description: '2FA disabled successfully',
    type: MessageResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid 2FA code' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  disable2fa(@Req() req: AuthRequest, @Body() body: TwoFactorCodeDto) {
    return this.authService.disable2fa(req.user.id, body.token);
  }

  @Post('verify-2fa-login')
  @ApiOperation({ summary: 'Verify 2FA code after login' })
  @ApiBody({ type: Verify2faLoginDto })
  @ApiResponse({
    status: 200,
    description: '2FA verified and access token returned',
    type: AccessTokenResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid 2FA code' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or invalid login session',
  })
  verify2faLogin(@Body() body: Verify2faLoginDto) {
    return this.authService.verify2faLogin(body.userId, body.token);
  }
}
