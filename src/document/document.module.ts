import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { Site } from 'src/site/entities/site.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { Document } from './entities/document.entity';
import { DocumentProcessingWorker } from './document-processing.worker';
import { ChatModule } from 'src/chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, Site]),
    BullModule.registerQueue({
      name: 'document-processing',
    }),
    ChatModule,
  ],
  providers: [DocumentService, DocumentProcessingWorker],
  controllers: [DocumentController],
})
export class DocumentModule {}
