import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminTestMessageItemDto {
  @ApiProperty({ enum: ['user', 'assistant', 'system'] })
  @IsEnum(['user', 'assistant', 'system'])
  role: 'user' | 'assistant' | 'system';

  @ApiProperty({ description: 'Content of the message' })
  @IsString()
  @IsNotEmpty()
  content: string;
}

export class AdminTestStreamDto {
  @ApiProperty({ description: 'ID of the site to test' })
  @IsUUID()
  siteId: string;

  @ApiProperty({
    type: [AdminTestMessageItemDto],
    description: 'Conversation messages history',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminTestMessageItemDto)
  messages: AdminTestMessageItemDto[];

  @ApiPropertyOptional({
    description: 'Optional system prompt override for testing',
  })
  @IsOptional()
  @IsString()
  systemPromptOverride?: string;
}
