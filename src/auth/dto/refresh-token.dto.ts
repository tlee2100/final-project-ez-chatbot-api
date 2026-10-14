import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh.signature',
    description: 'The refresh token obtained during login',
  })
  @IsNotEmpty()
  @IsString()
  refreshToken: string;
}
