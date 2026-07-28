import { ApiProperty } from '@nestjs/swagger';

export class AccessTokenResponseDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAifQ.signature',
    description: 'JWT access token',
  })
  accessToken: string;
}

export class LoginTwoFactorRequiredResponseDto {
  @ApiProperty({ example: true })
  requires2FA: boolean;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'User ID to submit with the 2FA verification code',
  })
  userId: string;

  @ApiProperty({ example: '2FA required' })
  message: string;
}

export class SetupTwoFactorResponseDto {
  @ApiProperty({
    example: 'XDQXYCP5AC6FA32FQXDGJSPBIZODINET',
    description: 'TOTP secret used to configure the authenticator app',
  })
  secret: string;

  @ApiProperty({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
    description: 'QR code data URL for authenticator app setup',
  })
  qrCodeUrl: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: '2FA enabled successfully' })
  message: string;
}
