import {
  Body,
  Controller,
  Get,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { TenantScopeInterceptor } from '../common/interceptors/tenant-scope.interceptor';
import { UserRole } from '../user/enums/user-role.enum';
import { CrawlerService } from './crawler.service';
import {
  CrawlPagesQueryDto,
  ManualUrlIngestionDto,
  UpdateCrawlerConfigDto,
} from './dto/crawler.dto';

@ApiTags('Crawler')
@ApiBearerAuth()
@Controller('sites/:siteId/kb')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@UseInterceptors(TenantScopeInterceptor)
export class CrawlerController {
  constructor(private readonly crawlerService: CrawlerService) {}

  @Get('crawler')
  @ApiOperation({ summary: 'Get crawler configuration and active run' })
  getConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.crawlerService.getConfig(siteId, req.user);
  }

  @Put('crawler')
  @ApiOperation({ summary: 'Create or update the site crawler configuration' })
  updateConfig(
    @Param('siteId') siteId: string,
    @Body() dto: UpdateCrawlerConfigDto,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.updateConfig(siteId, dto, req.user);
  }

  @Post('crawl')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start a full sitemap crawl' })
  @ApiResponse({ status: 202, description: 'Crawl accepted' })
  startCrawl(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.crawlerService.startSitemap(siteId, req.user);
  }

  @Post('upload/url')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest one public URL into the knowledge base' })
  ingestUrl(
    @Param('siteId') siteId: string,
    @Body() dto: ManualUrlIngestionDto,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.startManualUrl(siteId, dto.url, req.user);
  }

  @Get('crawls')
  @ApiOperation({ summary: 'List crawl runs' })
  listRuns(
    @Param('siteId') siteId: string,
    @Query('page') page: number,
    @Query('limit') limit: number,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.listRuns(siteId, page, limit, req.user);
  }

  @Get('crawls/:runId')
  @ApiOperation({ summary: 'Get crawl run progress' })
  getRun(
    @Param('siteId') siteId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.getRun(siteId, runId, req.user);
  }

  @Get('crawls/:runId/pages')
  @ApiOperation({ summary: 'List URL results for a crawl run' })
  listRunPages(
    @Param('siteId') siteId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Query() query: CrawlPagesQueryDto,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.listRunPages(siteId, runId, query, req.user);
  }

  @Post('crawls/:runId/retry-failed')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry failed URLs from a crawl run' })
  retryFailed(
    @Param('siteId') siteId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.retryFailed(siteId, runId, req.user);
  }

  @Delete('crawls/:runId/pages/:itemId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a failed URL from a crawl run' })
  deleteFailedItem(
    @Param('siteId') siteId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.deleteFailedItem(
      siteId,
      runId,
      itemId,
      req.user,
    );
  }

  @Post('sources/:documentId/recrawl')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Recrawl a single web knowledge source' })
  recrawlSource(
    @Param('siteId') siteId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.recrawlDocument(siteId, documentId, req.user);
  }

  @Post('sources/:documentId/reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Re-index one knowledge base source' })
  reindexSource(
    @Param('siteId') siteId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: AuthRequest,
  ) {
    return this.crawlerService.reindexDocument(siteId, documentId, req.user);
  }

  @Post('reindex-outdated')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Queue all outdated knowledge base sources' })
  reindexOutdated(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.crawlerService.reindexOutdated(siteId, req.user);
  }
}
