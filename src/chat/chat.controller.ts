import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Paginate } from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import { ChatService } from './chat.service';
import { GraphService } from './graph.service';
import { CreateConversationResponseDto } from './dto/create-conversation-response.dto';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';
import { DomainAllowlistGuard } from 'src/common/guards/domain-allowlist.guard';
import { ApiThrottlerGuard } from 'src/common/guards/api-throttler.guard';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly graphService: GraphService,
  ) {}

  // ─── Public: Visitor creates a new conversation ────────────────────────

  /**
   * Public — visitor submits the landing form to start a new conversation.
   */
  @UseGuards(DomainAllowlistGuard, ApiThrottlerGuard)
  @Post('conversations')
  createConversation(
    @Body() dto: CreateConversationDto,
  ): Promise<CreateConversationResponseDto> {
    return this.chatService.createConversation(dto);
  }

  // ─── Public: AI SSE streaming endpoint (visitor) ────────────────────────

  /**
   * Public — visitor's chat widget calls this to get an AI-streamed response.
   */
  @Post('conversations/:id/stream')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Transfer-Encoding', 'chunked')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  streamAiResponse(
    @Param('id') conversationId: string,
    @Body() dto: { siteId: string },
    @Res() res: Response,
  ) {
    return this.graphService.handleVisitorMessage(
      conversationId,
      dto.siteId,
      res,
    );
  }

  // ─── Public: Visitor fetches messages ─────────────────────────────────

  /**
   * Public — visitor gets their messages for a conversation.
   */
  @Get('public/conversations/:id/messages')
  getPublicConversationMessages(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.getMessagesForConversation(id, cursor, limit);
  }

  @Get('public/conversations/:id/status')
  getPublicConversationStatus(@Param('id') id: string) {
    return this.chatService.getPublicConversationStatus(id);
  }

  // ─── Protected: Agent/admin endpoints ─────────────────────────────────

  /**
   * Protected — agent/admin inbox: list active conversations.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations/active')
  getActiveConversations(
    @Paginate() query: PaginateQuery,
    @Req() req: AuthRequest,
  ) {
    return this.chatService.getActiveConversations(query, req.user);
  }

  /**
   * Protected — get conversation statistics for the inbox tabs.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations/stats')
  getConversationStats(
    @Req() req: AuthRequest,
    @Query('siteId') siteId?: string,
  ) {
    return this.chatService.getConversationStats(req.user, siteId);
  }

  /**
   * Protected — fetch a single conversation with its agent and site info.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations/:id')
  getConversation(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.chatService.getConversationForUser(id, req.user);
  }

  /**
   * Protected — fetch paginated message history for a conversation.
   */
  @UseGuards(JwtAuthGuard)
  @Get('conversations/:id/messages')
  getConversationMessages(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.getConversationMessagesForUser(
      id,
      req.user,
      cursor,
      limit,
    );
  }

  /**
   * Protected — update a conversation's status (agent/admin).
   */
  @UseGuards(JwtAuthGuard)
  @Patch('conversations/:id/status')
  async updateConversationStatus(
    @Param('id') id: string,
    @Body() dto: UpdateConversationStatusDto,
  ) {
    return this.chatService.updateConversationStatus(id, dto);
  }

  /**
   * Protected — close a conversation (admin/agent). (Legacy/Convenience)
   */
  @UseGuards(JwtAuthGuard)
  @Patch('conversations/:id/close')
  closeConversation(@Param('id') id: string) {
    return this.chatService.closeConversation(id);
  }

  /**
   * Protected — hard-delete a conversation (admin only).
   */
  @UseGuards(JwtAuthGuard)
  @Delete('conversations/:id')
  deleteConversation(@Param('id') id: string) {
    return this.chatService.deleteConversation(id);
  }

  @Patch('public/conversations/:id/status')
  async updatePublicConversationStatus(
    @Param('id') id: string,
    @Body() dto: UpdateConversationStatusDto,
  ) {
    return this.chatService.updatePublicConversationStatus(id, dto);
  }

  @Patch('public/conversations/:id/call-agent')
  async callAgent(@Param('id') id: string) {
    return this.chatService.escalateToAgent(id);
  }
}
