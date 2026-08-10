import { AutoMap } from '@automapper/classes';
import { ApiProperty } from '@nestjs/swagger';
import { KnowledgeBaseStatus } from '../enums/knowledge-base-status.enum';
import { UserDto } from '../../user/dto/user.dto';

export class SiteDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Site ID',
  })
  @AutoMap()
  id: string;

  @ApiProperty({
    example: 'Zodinet',
    description: 'Site name',
  })
  @AutoMap()
  name: string;

  @ApiProperty({
    example: 'https://zodinet.com',
    description: 'Site URL',
  })
  @AutoMap()
  url: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Owner user ID',
  })
  @AutoMap()
  ownerId: string;

  @ApiProperty({
    enum: KnowledgeBaseStatus,
    example: KnowledgeBaseStatus.PENDING,
    description: 'Knowledge base processing status',
  })
  @AutoMap(() => String)
  knowledgeBaseStatus: KnowledgeBaseStatus;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Organization ID',
    nullable: true,
  })
  @AutoMap(() => String)
  organizationId: string | null;

  @ApiProperty({
    example: 5,
    description: 'Number of knowledge base documents',
  })
  @AutoMap()
  kbDocuments: number;

  @ApiProperty({
    example: true,
    description: 'Whether the AI is active for this site',
  })
  @AutoMap()
  isAiActive: boolean;

  @ApiProperty({
    description: 'Assigned agents for this site',
    type: () => [UserDto],
    nullable: true,
  })
  @AutoMap(() => UserDto)
  agents?: UserDto[];

  @ApiProperty({
    type: [String],
    description:
      'Allowed domains for the chat widget (e.g., example.com, *.example.com)',
    example: ['example.com', '*.example.com'],
  })
  @AutoMap(() => [String])
  allowedDomains: string[];
}
