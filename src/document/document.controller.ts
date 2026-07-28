import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
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
import { documentUploadOptions } from './document-upload.options';
import { DocumentService } from './document.service';

@ApiTags('Documents')
@ApiBearerAuth()
@Controller()
export class DocumentController {
  constructor(private readonly documentService: DocumentService) {}

  @Post('sites/:siteId/documents/upload')
  @ApiOperation({ summary: 'Upload document to owned site' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'PDF or TXT document file',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Document uploaded successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or missing file' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Site not found' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  @UseInterceptors(FileInterceptor('file', documentUploadOptions))
  async uploadDocument(
    @Param('siteId') siteId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ) {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    return this.documentService.uploadDocument(siteId, file, req.user);
  }
}
