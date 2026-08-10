import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiService } from './ai.service';
import { GraphService } from './graph.service';
import { McpToolProviderFactory } from './providers/mcp-tool-provider.factory';
import { TOOL_PROVIDER } from './interfaces/tool-provider.interface';
import { Conversation } from './entities/conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import { NotificationModule } from '../notification/notification.module';
import { AiAgentModule } from '../ai-agent/ai-agent.module';
import { SiteModule } from '../site/site.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ChatMessage, Site, User]),
    NotificationModule,
    AiAgentModule,
    SiteModule,
    (() => {
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        throw new Error(
          'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
        );
      }
      return JwtModule.register({ secret: jwtSecret });
    })(),
  ],
  controllers: [ChatController],
  providers: [
    ChatGateway,
    ChatService,
    AiService,
    GraphService,
    McpToolProviderFactory,
    {
      provide: TOOL_PROVIDER,
      useExisting: McpToolProviderFactory,
    },
  ],
  exports: [ChatGateway, ChatService, GraphService],
})
export class ChatModule {}
