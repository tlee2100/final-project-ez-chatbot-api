import { ApiProperty } from '@nestjs/swagger';

export class CloseConversationResponseDto {
  @ApiProperty({ example: '735a97d0-258d-4836-8200-1a10cd0f6803' })
  conversationId: string;

  @ApiProperty({ example: 'CLOSED' })
  status: string;

  @ApiProperty({ example: 'AGENT_HANDLING' })
  handlingStatus: string;

  @ApiProperty({ example: 'VISITOR', nullable: true })
  closedReason: string | null;

  @ApiProperty({ example: '2026-08-25T09:33:35.255Z' })
  updatedAt: Date;
}
