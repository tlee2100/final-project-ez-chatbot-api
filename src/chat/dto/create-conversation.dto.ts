import {
  IsEmail,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUUID,
} from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  siteId: string;

  @IsOptional()
  @IsString()
  visitorName?: string;

  @IsOptional()
  @IsEmail()
  visitorEmail?: string;

  @IsOptional()
  @IsString()
  @IsTimeZone()
  timezone?: string;
}

