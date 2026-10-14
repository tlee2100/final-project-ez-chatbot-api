import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Document } from '../document/entities/document.entity';
import { Conversation } from '../chat/entities/conversation.entity';
import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import { DocumentModule } from '../document/document.module';
import { BookingModule } from '../booking/booking.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

/**
 * McpModule wires up all internal MCP API endpoints (MCP-002, MCP-003).
 *
 * Imports:
 *  - JwtModule: for McpService.validateToken() — validates per-session tokens
 *    issued by the chat agent using the shared JWT_SECRET.
 *  - TypeOrmModule(Document, Conversation, User, Site): for listDocuments, getConversationContext, getUserDetails & getSiteConfig.
 *  - DocumentModule: exposes KnowledgeRetrievalService (PR #66) for real
 *    vector similarity search — Option C (Adapter) per Decision 1.
 *
 * This module exposes NO public exports — it is self-contained.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
    }),
    TypeOrmModule.forFeature([Document, Conversation, User, Site]),
    DocumentModule,
    BookingModule,
  ],
  controllers: [McpController],
  providers: [McpService],
})
export class McpModule {}
