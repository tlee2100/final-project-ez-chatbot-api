import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  IsBoolean,
} from 'class-validator';

export class CreateSiteDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @IsUrl()
  url: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Agent user IDs assigned to this site',
    example: ['b2d5f8d5-2f35-4c76-8d84-123456789abc'],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  agentIds?: string[];

  @ApiPropertyOptional({
    description:
      'Organization to own this site (SUPER_ADMIN only; ADMIN is always forced to their own organization)',
  })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the AI is active for this site',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  isAiActive?: boolean;
}
