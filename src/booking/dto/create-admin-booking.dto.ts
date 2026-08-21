import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class AdminBookingSlotItemDto {
  @ApiProperty()
  @IsUUID()
  @IsNotEmpty()
  resourceId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  date: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  timeSlot: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  serviceId?: string;
}

export class CreateAdminBookingDto {
  @ApiPropertyOptional({ description: 'Staff or resource UUID' })
  @IsUUID()
  @IsOptional()
  staffId?: string;

  @ApiPropertyOptional({ description: 'Primary service UUID' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'List of service UUIDs', type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  serviceIds?: string[];

  @ApiPropertyOptional({
    description: 'Array of selected slots for multi-slot booking',
    type: [AdminBookingSlotItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AdminBookingSlotItemDto)
  @IsOptional()
  slots?: AdminBookingSlotItemDto[];

  @ApiPropertyOptional({ description: 'Booking start timestamp (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  startAt?: string;

  @ApiPropertyOptional({ description: 'Booking end timestamp (ISO 8601)' })
  @IsDateString()
  @IsOptional()
  endAt?: string;

  @ApiPropertyOptional({
    description: 'Timezone identifier (e.g., Asia/Ho_Chi_Minh)',
  })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiProperty({ description: 'Customer full name' })
  @IsString()
  @IsNotEmpty()
  customerName: string;

  @ApiProperty({ description: 'Customer phone number' })
  @IsString()
  @IsNotEmpty()
  customerPhone: string;

  @ApiPropertyOptional({ description: 'Customer email address' })
  @IsEmail()
  @IsOptional()
  customerEmail?: string;

  @ApiPropertyOptional({ description: 'Optional booking notes' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({ description: 'Client session ID' })
  @IsString()
  @IsNotEmpty()
  sessionId: string;
}
