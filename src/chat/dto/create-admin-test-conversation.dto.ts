import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * DTO for the admin-only test conversation endpoint.
 *
 * Unlike CreateConversationDto (public widget), this does not require
 * visitorName/visitorEmail because the conversation is owned by the admin
 * and is clearly marked as a test session.
 */
export class CreateAdminTestConversationDto {
  @ApiProperty({
    description: 'The UUID of the site to test',
    example: 'cfb5c3ee-74bb-4064-ad2f-f5413b9867b6',
  })
  @IsUUID()
  siteId: string;
}
