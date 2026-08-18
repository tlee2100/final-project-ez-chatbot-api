import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentModule } from '../document/document.module';
import { DocumentChunk } from '../document/entities/document-chunk.entity';
import { Document } from '../document/entities/document.entity';
import { Site } from '../site/entities/site.entity';
import { SiteModule } from '../site/site.module';
import { CRAWLER_QUEUE } from './constants/crawler.constants';
import { CrawlerController } from './crawler.controller';
import { CrawlerProcessor } from './crawler.processor';
import { CrawlerService } from './crawler.service';
import { CrawlerConfig } from './entities/crawler-config.entity';
import { CrawlRunItem } from './entities/crawl-run-item.entity';
import { CrawlRun } from './entities/crawl-run.entity';
import { CrawlerHttpService } from './services/crawler-http.service';
import { CrawlerIndexingService } from './services/crawler-indexing.service';
import { CrawlerUrlService } from './services/crawler-url.service';
import { HostLockService } from './services/host-lock.service';
import { PageExtractorService } from './services/page-extractor.service';
import { PageRendererService } from './services/page-renderer.service';
import { RobotsService } from './services/robots.service';
import { SitemapService } from './services/sitemap.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CrawlerConfig,
      CrawlRun,
      CrawlRunItem,
      Document,
      DocumentChunk,
      Site,
    ]),
    BullModule.registerQueue({ name: CRAWLER_QUEUE }),
    SiteModule,
    DocumentModule,
  ],
  controllers: [CrawlerController],
  providers: [
    CrawlerService,
    CrawlerProcessor,
    CrawlerUrlService,
    CrawlerHttpService,
    RobotsService,
    SitemapService,
    HostLockService,
    PageRendererService,
    PageExtractorService,
    CrawlerIndexingService,
  ],
})
export class CrawlerModule {}
