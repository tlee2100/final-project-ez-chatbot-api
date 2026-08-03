import { ApiProperty } from '@nestjs/swagger';

export class AccessTokenResponseDto {
  @ApiProperty({
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAifQ.signature',
    description: 'JWT access token',
  })
  accessToken: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Logged out successfully' })
  message: string;
}
