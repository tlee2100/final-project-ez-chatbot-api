import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export const ORGANIZATION_SORT_FIELDS = [
  'name',
  'slug',
  'createdAt',
  'updatedAt',
] as const;

export type OrganizationSortField = (typeof ORGANIZATION_SORT_FIELDS)[number];

export class QueryOrganizationDto {
  @ApiPropertyOptional({
    description: 'Page number',
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({
    description: 'Items per page',
    example: 10,
    minimum: 1,
    maximum: 100,
    default: 10,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Filter by organization name',
    example: 'Zodinet',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Filter by organization slug',
    example: 'zodinet',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    description: 'Filter by organization status',
    example: 'Active',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({
    description: 'Sort field',
    enum: ORGANIZATION_SORT_FIELDS,
    example: 'name',
  })
  @IsOptional()
  @IsEnum(ORGANIZATION_SORT_FIELDS)
  sortBy?: OrganizationSortField;

  @ApiPropertyOptional({
    description: 'Sort order',
    enum: ['ASC', 'DESC'],
    example: 'ASC',
    default: 'ASC',
  })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC' = 'ASC';
}
