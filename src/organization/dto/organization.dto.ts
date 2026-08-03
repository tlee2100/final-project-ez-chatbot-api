import { AutoMap } from '@automapper/classes';
import { ApiProperty } from '@nestjs/swagger';

export class OrganizationOwnerDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Owner user ID',
  })
  @AutoMap()
  id: string;

  @ApiProperty({
    example: 'Nguyen Van A',
    description: 'Owner name',
  })
  @AutoMap()
  name: string;

  @ApiProperty({
    example: 'user@gmail.com',
    description: 'Owner email',
  })
  @AutoMap()
  email: string;

  @ApiProperty({
    nullable: true,
    description: 'Owner avatar URL',
  })
  @AutoMap(() => String)
  avatarUrl?: string | null;
}

export class OrganizationDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Organization ID',
  })
  @AutoMap()
  id: string;

  @ApiProperty({
    example: 'Zodinet',
    description: 'Organization name',
  })
  @AutoMap()
  name: string;

  @ApiProperty({
    example: 'zodinet',
    description: 'Unique organization slug',
  })
  @AutoMap()
  slug: string;

  @ApiProperty({
    example: 'Active',
    description: 'Organization status',
  })
  @AutoMap()
  status: string;

  @ApiProperty({
    example: 'Notes here',
    description: 'Internal notes about this tenant',
    nullable: true,
  })
  @AutoMap(() => String)
  notes: string | null;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Organization owner user ID',
    nullable: true,
  })
  @AutoMap(() => String)
  ownerId: string | null;

  @ApiProperty({
    example: '2026-07-10T00:00:00.000Z',
    description: 'Creation timestamp',
  })
  @AutoMap()
  createdAt: Date;

  @ApiProperty({
    example: '2026-07-10T00:00:00.000Z',
    description: 'Last update timestamp',
  })
  @AutoMap()
  updatedAt: Date;

  @ApiProperty({
    description: 'Organization owner object',
    nullable: true,
    type: () => OrganizationOwnerDto,
  })
  @AutoMap(() => OrganizationOwnerDto)
  owner: OrganizationOwnerDto | null;

  @ApiProperty({
    example: 3,
    description: 'Number of sites in this organization',
  })
  sitesCount: number;

  @ApiProperty({
    example: 2,
    description: 'Number of agent-role users in this organization',
  })
  agentsCount: number;
}
