import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Zodinet' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'zodinet' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Slug may only contain lowercase letters, numbers, and hyphens',
  })
  slug: string;

  @ApiPropertyOptional({
    description: 'Organization status',
    example: 'Active',
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Internal notes about this tenant' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'The user ID of the organization owner' })
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;
}
