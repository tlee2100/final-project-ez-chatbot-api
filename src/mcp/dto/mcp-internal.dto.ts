import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsUUID,
  IsEmail,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
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
  @Transform(({ value }) =>
    value && typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined,
  )
  @ValidateIf(
    (o: { customerEmail?: unknown }) =>
      typeof o.customerEmail === 'string' && o.customerEmail.trim().length > 0,
  )
  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @ApiProperty({ example: '0912345678' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ example: 'uuid-of-service', required: false })
  @IsString()
  @IsOptional()
  serviceId?: string;

  @ApiProperty({
    example: ['uuid-of-service-1', 'uuid-of-service-2'],
    required: false,
  })
  @IsOptional()
  @IsUUID('4', { each: true })
  serviceIds?: string[];

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  slotCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  slots?: Array<{
    resourceId: string;
    date: string;
    timeSlot: string;
    serviceId?: string;
  }>;

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

  @ApiProperty({ example: 'uuid-session-id', required: false })
  @IsString()
  @IsOptional()
  sessionId?: string;
}

/** DTO for POST /api/internal/mcp/booking/cancel */
export class McpCancelBookingDto {
  @ApiProperty({ example: 'BK-0001' })
  @IsString()
  @IsNotEmpty()
  bookingCode: string;
}

/** DTO for POST /api/internal/mcp/booking/hold */
export class McpHoldSlotDto {
  @ApiProperty({ example: 'uuid-of-service', required: false })
  @IsString()
  @IsOptional()
  serviceId?: string;

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  slotCount?: number;

  @ApiProperty({ example: ['09:00', '09:30'], required: false })
  @IsOptional()
  timeSlots?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  slots?: Array<{
    resourceId: string;
    date: string;
    timeSlot: string;
    serviceId?: string;
  }>;

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

/** DTO for POST /api/internal/mcp/booking/release */
export class McpReleaseHoldDto {
  @ApiProperty({ example: 'uuid-of-resource', required: false })
  @IsString()
  @IsOptional()
  resourceId?: string;

  @ApiProperty({ example: '2026-08-10', required: false })
  @IsString()
  @IsOptional()
  date?: string;

  @ApiProperty({ example: '09:00', required: false })
  @IsString()
  @IsOptional()
  timeSlot?: string;

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  slotCount?: number;

  @ApiProperty({ example: 'uuid-session-id', required: false })
  @IsString()
  @IsOptional()
  sessionId?: string;
}
