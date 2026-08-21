import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class SelectedSlotDto {
  @IsUUID()
  @IsNotEmpty()
  resourceId: string;

  @IsString()
  @IsNotEmpty()
  date: string;

  @IsString()
  @IsNotEmpty()
  timeSlot: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;
}

export class CreateBookingDto {
  @IsUUID()
  @IsNotEmpty()
  siteId: string;

  @IsUUID()
  @IsOptional()
  resourceId?: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsOptional()
  @IsUUID('4', { each: true })
  serviceIds?: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedSlotDto)
  @IsOptional()
  slots?: SelectedSlotDto[];

  @IsDateString()
  @IsNotEmpty()
  startAt: string;

  @IsDateString()
  @IsNotEmpty()
  endAt: string;

  @IsString()
  @IsNotEmpty()
  timezone: string;

  @IsString()
  @IsNotEmpty()
  customerName: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsOptional()
  customerEmail?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  @IsObject()
  @IsOptional()
  templateFields?: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  sessionId: string;
}
