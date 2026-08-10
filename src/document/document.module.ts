import { Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { Site } from 'src/site/entities/site.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { Document } from './entities/document.entity';
import { DocumentChunk } from './entities/document-chunk.entity';
import { DocumentProcessingWorker } from './document-processing.worker';
import { NotificationModule } from 'src/notification/notification.module';
import { SiteModule } from 'src/site/site.module';
import { DocumentChunkingService } from './chunking/document-chunking.service';
import { EmbeddingService } from './embedding/embedding.service';
import { DocumentIngestionService } from './document-ingestion.service';
import { KnowledgeRetrievalService } from './retrieval/knowledge-retrieval.service';
import { PgVectorChunkSearchRepository } from './retrieval/pgvector-chunk-search.repository';
import { CHUNK_SEARCH_REPOSITORY } from './constants/document.tokens';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, DocumentChunk, Site]),
    BullModule.registerQueue({
      name: 'document-processing',
    }),
    NotificationModule,
    SiteModule,
  ],
  providers: [
    DocumentService,
    DocumentProcessingWorker,
    DocumentChunkingService,
    EmbeddingService,
    DocumentIngestionService,
    KnowledgeRetrievalService,
    {
      provide: CHUNK_SEARCH_REPOSITORY,
      useClass: PgVectorChunkSearchRepository,
    },
  ],
  controllers: [DocumentController],
  exports: [KnowledgeRetrievalService],
})
export class DocumentModule {}
