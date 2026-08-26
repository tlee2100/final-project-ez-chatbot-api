import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  siteId: string;

  @IsOptional()
  @IsString()
  visitorName?: string;

  @IsOptional()
  @IsEmail()
  visitorEmail?: string;
}
