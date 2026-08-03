import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional, IsBoolean } from 'class-validator';

export class UpdateSiteDto {
  @ApiPropertyOptional({ example: 'My Site Updated' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: 'https://example.com/updated' })
  @IsUrl()
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether the AI is active for this site',
  })
  @IsOptional()
  @IsBoolean()
  isAiActive?: boolean;
}
