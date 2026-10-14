import { forwardRef, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { AiService } from './ai.service';
import { GraphService } from './graph.service';
import { ChatTimeoutService } from './chat-timeout.service';
import { McpToolProviderFactory } from './providers/mcp-tool-provider.factory';
import { TOOL_PROVIDER } from './interfaces/tool-provider.interface';
import { Conversation } from './entities/conversation.entity';
import { ChatMessage } from './entities/chat-message.entity';
import { User } from '../user/entities/user.entity';
import { Site } from '../site/entities/site.entity';
import { NotificationModule } from '../notification/notification.module';
import { SiteModule } from '../site/site.module';
import { BookingModule } from '../booking/booking.module';
import { SecurityModule } from '../security/security.module';
import { PageContextService } from './page-context.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ChatMessage, Site, User]),
    NotificationModule,
    forwardRef(() => SiteModule),
    forwardRef(() => BookingModule),
    SecurityModule,
    JwtModule.registerAsync({
      useFactory: () => {
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error(
            'Missing JWT_SECRET environment variable. Please set JWT_SECRET in your .env',
          );
        }
        return { secret: jwtSecret };
      },
    }),
  ],
  controllers: [ChatController],
  providers: [
    ChatGateway,
    ChatService,
    ChatTimeoutService,
    AiService,
    GraphService,
    PageContextService,
    McpToolProviderFactory,
    {
      provide: TOOL_PROVIDER,
      useExisting: McpToolProviderFactory,
    },
  ],
  exports: [ChatGateway, ChatService, GraphService, ChatTimeoutService],
})
export class ChatModule {}
