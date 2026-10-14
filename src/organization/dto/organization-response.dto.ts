import { ApiProperty } from '@nestjs/swagger';
import { OrganizationDto } from './organization.dto';

export class OrganizationResponseDto {
  @ApiProperty({
    type: () => OrganizationDto,
    description: 'Organization payload',
  })
  data: OrganizationDto;
}

export class DeleteOrganizationResponseDto {
  @ApiProperty({
    example: { id: '550e8400-e29b-41d4-a716-446655440000' },
  })
  data: { id: string };
}

export class PaginatedOrganizationMetaDto {
  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  limit: number;

  @ApiProperty({ example: 42 })
  totalItems: number;

  @ApiProperty({ example: 5 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;
}

export class PaginatedOrganizationsDto {
  @ApiProperty({
    type: () => [OrganizationDto],
    description: 'Organizations on the current page',
  })
  data: OrganizationDto[];

  @ApiProperty({
    type: () => PaginatedOrganizationMetaDto,
    description: 'Pagination metadata',
  })
  meta: PaginatedOrganizationMetaDto;
}
