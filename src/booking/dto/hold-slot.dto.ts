import { IsDateString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class HoldSlotDto {
  @IsUUID()
  @IsNotEmpty()
  resourceId: string;

  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @IsDateString()
  @IsNotEmpty()
  startAt: string;

  @IsDateString()
  @IsNotEmpty()
  endAt: string;

  @IsUUID()
  @IsNotEmpty()
  sessionId: string;
}
