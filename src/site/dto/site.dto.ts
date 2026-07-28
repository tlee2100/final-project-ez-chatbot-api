import { AutoMap } from '@automapper/classes';
import { ApiProperty } from '@nestjs/swagger';
import { KnowledgeBaseStatus } from '../enums/knowledge-base-status.enum';

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
}
