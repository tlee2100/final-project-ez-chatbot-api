import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateBlockoutDto {
  @ApiPropertyOptional({
    description:
      'Optional staff/resource ID. If omitted or null, blockout applies to the entire salon (all staff).',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  resourceId?: string | null;

  @ApiProperty({
    description:
      'Start time of the blockout period (ISO 8601 string with timezone)',
    example: '2026-04-30T00:00:00.000Z',
  })
  @IsDateString()
  startAt: string;

  @ApiProperty({
    description:
      'End time of the blockout period (ISO 8601 string with timezone)',
    example: '2026-04-30T23:59:59.999Z',
  })
  @IsDateString()
  endAt: string;

  @ApiPropertyOptional({
    description:
      'Reason for the blockout (e.g. Public Holiday, Staff Leave, Maintenance)',
    example: '30/04 Public Holiday - Reunification Day',
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string | null;
}
