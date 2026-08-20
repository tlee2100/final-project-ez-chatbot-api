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
  BadRequestException,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../user/enums/user-role.enum';
import { Paginate } from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import { ChatService } from './chat.service';
import { GraphService } from './graph.service';
import { CreateConversationResponseDto } from './dto/create-conversation-response.dto';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { UpdateConversationStatusDto } from './dto/update-conversation-status.dto';
import {
  SubmitMessageFeedbackDto,
  MessageFeedbackResponseDto,
} from './dto/submit-message-feedback.dto';
import { DomainAllowlistGuard } from 'src/common/guards/domain-allowlist.guard';
import { ApiThrottlerGuard } from 'src/common/guards/api-throttler.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { validateAndGetImageFile } from '../utils/file-signature.util';
import { ClosedReason } from './entities/conversation.entity';
import { CreateAdminTestConversationDto } from './dto/create-admin-test-conversation.dto';
import { AdminTestStreamDto } from './dto/admin-test-stream.dto';

@ApiTags('Chat')
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

  // ─── Admin: Create test conversation (authenticated) ──────────────────────

  /**
   * Protected — admin/owner creates a sandboxed test conversation for their
   * site. Unlike the public endpoint this bypasses:
   *   - DomainAllowlistGuard (not a visitor origin)
   *   - Agent inbox notifications (keeps the inbox clean)
   *
   * Authorization: site owner or SUPER_ADMIN only (enforced in service layer).
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('admin-test/conversations')
  createAdminTestConversation(
    @Body() dto: CreateAdminTestConversationDto,
    @Req() req: AuthRequest,
  ): Promise<CreateConversationResponseDto> {
    return this.chatService.createAdminTestConversation(dto.siteId, req.user);
  }

  // ─── Admin: Stream test chat response (stateless SSE) ──────────────────────

  /**
   * Protected — admin/owner tests chatbot responses with live Knowledge Base & tools.
   * Completely stateless & ephemeral: does NOT save anything to conversations or chat_messages tables.
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('admin-test/stream')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @Header('Transfer-Encoding', 'chunked')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async streamAdminTestResponse(
    @Body() dto: AdminTestStreamDto,
    @Req() req: AuthRequest,
    @Res() res: Response,
  ) {
    const site = await this.chatService.assertSiteAccessForTest(
      dto.siteId,
      req.user,
    );
    return this.graphService.handleAdminTestStream(dto, site, res);
  }
  // ─── Public: AI SSE streaming endpoint (visitor) ────────────────────────

  /**
   * Public — visitor's chat widget calls this to get an AI-streamed response.
   */
  @UseGuards(DomainAllowlistGuard, ApiThrottlerGuard)
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

  // ─── Public: Visitor message feedback (thumbs up / down) ───────────────

  /**
   * Public — visitor submits thumbs up/down rating on an AI bot message.
   */
  @UseGuards(DomainAllowlistGuard, ApiThrottlerGuard)
  @Post('public/messages/:id/feedback')
  @ApiOperation({
    summary: 'Submit feedback on an AI message (thumbs up / down)',
    description:
      'Allows a visitor to submit binary feedback (HELPFUL or UNHELPFUL) on an AI-generated message.',
  })
  @ApiParam({
    name: 'id',
    type: 'string',
    format: 'uuid',
    description: 'Message UUID (must be an AI bot message)',
  })
  @ApiBody({ type: SubmitMessageFeedbackDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Feedback successfully recorded',
    type: MessageFeedbackResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Message not found or message was not sent by AI',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input payload or malformed UUID',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description: 'Rate limit exceeded',
  })
  submitMessageFeedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SubmitMessageFeedbackDto,
  ): Promise<MessageFeedbackResponseDto> {
    return this.chatService.submitMessageFeedback(id, dto);
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
    return this.chatService.closeConversation(id, ClosedReason.AGENT);
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

  // ─── Attachments ────────────────────────────────────────────────────────

  @Post('public/conversations/:id/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachmentPublic(
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const validFile = validateAndGetImageFile(file);
    const url = await this.chatService.uploadAttachment(validFile);
    return { url };
  }

  @UseGuards(JwtAuthGuard)
  @Post('conversations/:id/upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAttachmentAgent(
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const validFile = validateAndGetImageFile(file);
    const url = await this.chatService.uploadAttachment(validFile);
    return { url };
  }
}
