import { AutoMap } from '@automapper/classes';
import { UserRole } from '../enums/user-role.enum';
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
}

export class PaginatedUserMetaDto {
  @ApiProperty({
    example: 1,
    description: 'Current page',
  })
  page: number;

  @ApiProperty({
    example: 10,
    description: 'Items per page',
  })
  limit: number;

  @ApiProperty({
    example: 42,
    description: 'Total number of users',
  })
  total: number;

  @ApiProperty({
    example: 5,
    description: 'Total number of pages',
  })
  totalPages: number;
}

export class PaginatedUsersDto {
  @ApiProperty({
    type: () => [UserDto],
    description: 'Users on the current page',
  })
  data: UserDto[];

  @ApiProperty({
    type: () => PaginatedUserMetaDto,
    description: 'Pagination metadata',
  })
  meta: PaginatedUserMetaDto;
}

export class DeleteUserResponseDto {
  @ApiProperty({
    example: 'User deleted successfully',
    description: 'Deletion result message',
  })
  message: string;
}
