import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';
import { Paginate } from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { CreateConversationDto } from './dto/create-conversation.dto';
import type { JwtUser } from '../auth/types/jwt-user.type';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  /**
   * Public — visitor submits the landing form to start a new conversation.
   */
  @Post('conversations')
  async createConversation(@Body() dto: CreateConversationDto) {
    const { conversation, firstMessage } =
      await this.chatService.createConversation(dto);

    // Notify connected agents watching this site
    this.chatGateway.notifyAgentsOfNewConversation(conversation);

    return {
      conversationId: conversation.id,
      siteId: conversation.siteId,
      visitorName: conversation.visitorName,
      visitorEmail: conversation.visitorEmail,
      status: conversation.status,
      handlingStatus: conversation.handlingStatus,
      firstMessage: {
        id: firstMessage.id,
        content: firstMessage.content,
        createdAt: firstMessage.createdAt,
      },
    };
  }

  /**
   * Public — visitor gets their messages for a conversation.
   */
  @Get('public/conversations/:id/messages')
  async getPublicConversationMessages(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const cursorDate = cursor ? new Date(cursor) : undefined;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.chatService.getMessagesForConversation(
      id,
      cursorDate,
      parsedLimit,
    );
  }

  /**
   * Protected — agent/admin inbox: list active conversations.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('conversations/active')
  async getActiveConversations(
    @Paginate() query: PaginateQuery,
    @Req() req: Request,
  ) {
    const user = req.user as JwtUser;
    return this.chatService.getActiveConversations(query, user);
  }

  /**
   * Protected — fetch a single conversation with its agent and site info.
   * Agents can only view unclaimed or their own conversations.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('conversations/:id')
  async getConversation(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtUser;
    return this.chatService.getConversationForUser(id, user);
  }

  /**
   * Protected — fetch paginated message history for a conversation.
   * Enforces the same visibility rules as getConversation.
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('conversations/:id/messages')
  async getConversationMessages(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const user = req.user as JwtUser;
    await this.chatService.getConversationForUser(id, user);
    const cursorDate = cursor ? new Date(cursor) : undefined;
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.chatService.getMessagesForConversation(
      id,
      cursorDate,
      parsedLimit,
    );
  }

  /**
   * Protected — close a conversation (admin/agent).
   */
  @UseGuards(AuthGuard('jwt'))
  @Patch('conversations/:id/close')
  async closeConversation(@Param('id') id: string) {
    const conversation = await this.chatService.closeConversation(id);
    this.chatGateway.notifyConversationClosed(id, conversation.siteId);
    return conversation;
  }

  /**
   * Protected — hard-delete a conversation (admin only).
   */
  @UseGuards(AuthGuard('jwt'))
  @Delete('conversations/:id')
  async deleteConversation(@Param('id') id: string) {
    const conversation = await this.chatService.deleteConversation(id);
    this.chatGateway.notifyConversationClosed(id, conversation.siteId);
    return { success: true };
  }
}
