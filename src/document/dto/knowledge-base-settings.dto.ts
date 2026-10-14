import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class UpdateKnowledgeBaseSettingsDto {
  @ApiPropertyOptional({ minimum: 100, maximum: 2000, example: 800 })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(2000)
  chunkSize?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 500, example: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  chunkOverlap?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20, example: 4 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topKResults?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1, example: 0.5 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  similarityThreshold?: number;
}

export class KnowledgeBaseSettingsDto {
  @ApiProperty({ example: 800 })
  chunkSize: number;

  @ApiProperty({ example: 100 })
  chunkOverlap: number;

  @ApiProperty({ example: 4 })
  topKResults: number;

  @ApiProperty({ example: 0.5 })
  similarityThreshold: number;

  @ApiProperty({ example: 3 })
  outdatedDocumentsCount: number;
}
