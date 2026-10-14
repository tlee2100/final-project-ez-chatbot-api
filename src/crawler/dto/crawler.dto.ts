import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CrawlRunItemStatus } from '../enums/crawler.enums';

export class UpdateCrawlerConfigDto {
  @ApiProperty({ example: 'https://example.com/sitemap.xml' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  sitemapUrl: string;

  @ApiProperty({ default: false })
  @IsBoolean()
  autoSyncEnabled: boolean;
}

export class ManualUrlIngestionDto {
  @ApiProperty({ example: 'https://example.com/help/getting-started' })
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url: string;
}

export class CrawlPagesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: CrawlRunItemStatus })
  @IsOptional()
  @IsEnum(CrawlRunItemStatus)
  status?: CrawlRunItemStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  search?: string;
}

export class StartCrawlResponseDto {
  @ApiProperty()
  runId: string;

  @ApiProperty({ example: 'queued' })
  status: string;
}
