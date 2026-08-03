import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserGender } from '../entities/user.entity';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'Nguyen Van B' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: UserGender })
  @IsOptional()
  @IsEnum(UserGender)
  gender?: UserGender;

  @ApiPropertyOptional({ example: '1995-01-20', nullable: true })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ example: '+84901234567', nullable: true })
  @IsOptional()
  @IsString()
  phone?: string | null;
}

export class ChangePasswordDto {
  @ApiProperty({ example: 'oldPassword123' })
  @IsNotEmpty()
  @IsString()
  currentPassword: string;

  @ApiProperty({ example: 'newPassword123', minLength: 8, maxLength: 32 })
  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  newPassword: string;

  @ApiProperty({ example: 'newPassword123', minLength: 8, maxLength: 32 })
  @IsNotEmpty()
  @IsString()
  @MinLength(8)
  @MaxLength(32)
  confirmNewPassword: string;
}
