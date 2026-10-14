import {
  Controller,
  Body,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { UserRole } from 'src/user/enums/user-role.enum';
import type { AuthRequest } from 'src/auth/types/auth-request.type';
import { Paginate, type PaginateQuery } from 'nestjs-paginate';
import { documentUploadOptions } from './document-upload.options';
import { DocumentService } from './document.service';
import { DocumentUploadExceptionFilter } from './filters/document-upload.filter';
import { TenantScopeInterceptor } from 'src/common/interceptors/tenant-scope.interceptor';
import { UpdateKnowledgeBaseSettingsDto } from './dto/knowledge-base-settings.dto';

@ApiTags('Documents')
@ApiBearerAuth()
@Controller('sites/:siteId/kb')
@UseInterceptors(TenantScopeInterceptor)
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Get('settings')
  @ApiOperation({ summary: 'Get knowledge base settings for a site' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  getSettings(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.documentService.getKnowledgeBaseSettings(siteId, req.user);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Update knowledge base settings for a site' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  updateSettings(
    @Param('siteId') siteId: string,
    @Body() dto: UpdateKnowledgeBaseSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.updateKnowledgeBaseSettings(
      siteId,
      dto,
      req.user,
    );
  }

  @Get('sources')
  @ApiOperation({
    summary:
      'Get paginated Knowledge Base sources for a site (Admin/Owner only)',
    description:
      'Retrieve paginated list of knowledge base document sources associated with a specific siteId.',
  })
  @ApiResponse({ status: 200, description: 'Return paginated site KB sources' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden (Not site owner/admin)' })
  @ApiResponse({ status: 404, description: 'Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getSiteDocuments(
    @Param('siteId') siteId: string,
    @Paginate() query: PaginateQuery,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.getSiteDocuments(siteId, query, req.user);
  }

  @Post('upload/file')
  @ApiOperation({
    summary: 'Upload document file to site Knowledge Base (Admin/Owner only)',
    description:
      'Upload PDF, TXT, MD, HTML, or DOCX document file for Knowledge Base ingestion.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Document file (PDF, TXT, MD, HTML, DOCX)',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Document uploaded and queued for processing',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or corrupted file / Magic byte failure',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden (Not site owner/admin)' })
  @ApiResponse({ status: 404, description: 'Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  @UseFilters(DocumentUploadExceptionFilter)
  async uploadDocument(
    @Param('siteId') siteId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.uploadDocument(siteId, file, req.user);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get Knowledge Base statistics for a site (Admin/Owner only)',
    description:
      'Retrieve aggregate metrics of documents, chunks, vectors and token counts for a site.',
  })
  @ApiResponse({ status: 200, description: 'Return site KB statistics' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden (Not site owner/admin)' })
  @ApiResponse({ status: 404, description: 'Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getSiteKBStats(
    @Param('siteId') siteId: string,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.getSiteKBStats(siteId, req.user);
  }

  @Get('sources/:documentId/chunks')
  @ApiOperation({
    summary:
      'Get all chunks and embedding metadata for a document (Admin/Owner only)',
    description:
      'Retrieve ordered list of chunks with token counts, section titles, and embedding metadata.',
  })
  @ApiResponse({ status: 200, description: 'Return document chunks' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden (Not site owner/admin)' })
  @ApiResponse({ status: 404, description: 'Document or Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async getDocumentChunks(
    @Param('siteId') siteId: string,
    @Param('documentId') documentId: string,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.getDocumentChunks(siteId, documentId, req.user);
  }

  @Delete('sources/:documentId')
  @ApiOperation({
    summary: 'Delete Knowledge Base source from owned site (Admin/Owner only)',
    description:
      'Deletes document metadata from DB and destroys the file asset on Cloudinary.',
  })
  @ApiResponse({ status: 200, description: 'KB source deleted successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden (Not site owner/admin)' })
  @ApiResponse({ status: 404, description: 'Document or Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async deleteDocument(
    @Param('siteId') siteId: string,
    @Param('documentId') documentId: string,
    @Req() req: AuthRequest,
  ) {
    return this.documentService.deleteDocument(siteId, documentId, req.user);
  }
}
