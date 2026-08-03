import { AutoMap } from '@automapper/classes';
import { UserRole } from '../enums/user-role.enum';
import { UserGender } from '../entities/user.entity';
import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'User ID',
  })
  @AutoMap()
  id: string;

  @ApiProperty({
    example: 'user@gmail.com',
    description: 'User email',
  })
  @AutoMap()
  email: string;

  @ApiProperty({
    example: 'Nguyen Van A',
    description: 'User name',
  })
  @AutoMap()
  name: string;

  @ApiProperty({
    enum: UserRole,
    example: UserRole.AGENT,
    description: 'User role',
  })
  @AutoMap()
  role: UserRole;

  @ApiProperty({ enum: UserGender, nullable: true })
  @AutoMap(() => String)
  gender: UserGender | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  dateOfBirth: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  phone: string | null;

  @ApiProperty({ nullable: true })
  @AutoMap(() => String)
  avatarUrl: string | null;
}

export class CreateUserResponseDto {
  @ApiProperty({ type: () => UserDto })
  user: UserDto;

  @ApiProperty({ description: 'Initial password generated for the user' })
  initialPassword: string;
}

export class DeleteUserResponseDto {
  @ApiProperty({
    example: 'User deleted successfully',
    description: 'Deletion result message',
  })
  message: string;
}
