import { IsString, IsNotEmpty, IsOptional, IsInt } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** DTO for POST /api/internal/mcp/kb/search */
export class McpSearchKnowledgeDto {
  @ApiProperty({
    description: 'Search query string',
    example: 'What are your opening hours?',
  })
  @IsString()
  @IsNotEmpty()
  query: string;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored. Retrieval count is configured per site.',
  })
  @IsOptional()
  @IsInt()
  topK?: number;
}

/** DTO for POST /api/internal/mcp/booking/create */
export class McpCreateBookingDto {
  @ApiProperty({ example: 'Nguyen Van A' })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiProperty({ example: 'customer@example.com', required: false })
  @IsString()
  @IsOptional()
  customerEmail?: string;

  @ApiProperty({ example: '0912345678' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ example: 'uuid-of-service' })
  @IsString()
  @IsNotEmpty()
  serviceId: string;

  @ApiProperty({ example: 'uuid-of-resource' })
  @IsString()
  @IsNotEmpty()
  resourceId: string;

  @ApiProperty({ example: '2026-08-10' })
  @IsString()
  @IsNotEmpty()
  date: string;

  @ApiProperty({ example: '09:00' })
  @IsString()
  @IsNotEmpty()
  timeSlot: string;
}

/** DTO for POST /api/internal/mcp/booking/cancel */
export class McpCancelBookingDto {
  @ApiProperty({ example: 'BK-0001' })
  @IsString()
  @IsNotEmpty()
  bookingCode: string;
}
