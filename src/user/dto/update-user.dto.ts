import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { CreateUserDto } from './create-user.dto';
import { IsString } from 'class-validator';
import { IsOptional } from 'class-validator';
import { IsBoolean } from 'class-validator';

export class UpdateUserDto extends PartialType(
  OmitType(CreateUserDto, ['email', 'role'] as const),
) {
  @ApiPropertyOptional({
    example: false,
    description: 'Whether two-factor authentication is enabled',
  })
  @IsOptional()
  @IsBoolean()
  twoFactorEnabled?: boolean;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'Two-factor authentication secret',
  })
  @IsOptional()
  @IsString()
  twoFactorSecret?: string | null;
}
