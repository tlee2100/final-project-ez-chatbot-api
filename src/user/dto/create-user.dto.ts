import { IsEmail, IsNotEmpty, IsString, IsEnum, IsUUID } from 'class-validator';
import { UserRole } from '../enums/user-role.enum';
import { ApiProperty } from '@nestjs/swagger';
import { UserGender } from '../entities/user.entity';

export class CreateUserDto {
  @ApiProperty({ example: 'user@gmail.com' })
  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'Invalid email format' })
  email: string;

  @ApiProperty({ example: 'Nguyen Van A' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ enum: UserRole, example: UserRole.AGENT })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsNotEmpty()
  @IsUUID()
  organizationId: string;

  @ApiProperty({ enum: UserGender, example: UserGender.OTHER })
  @IsNotEmpty()
  @IsEnum(UserGender)
  gender: UserGender;
}
