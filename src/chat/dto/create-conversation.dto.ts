import { IsEmail, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateConversationDto {
  @IsUUID()
  siteId: string;

  @IsString()
  @MinLength(1)
  visitorName: string;

  @IsEmail()
  visitorEmail: string;
}
