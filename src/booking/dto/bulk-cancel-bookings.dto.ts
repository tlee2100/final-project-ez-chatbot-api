import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class BulkCancelBookingsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  bookingIds: string[];
}
