import { Body, Controller, Post, Req, UseGuards, Get } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SiteService } from './site.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { Roles } from 'src/auth/decorators/roles.decorator';
import {
  ApiOkPaginatedResponse,
  ApiPaginationQuery,
  Paginate,
  type PaginateQuery,
} from 'nestjs-paginate';

import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../user/enums/user-role.enum';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthRequest } from 'src/auth/types/auth-request.type';
import { SiteDto } from './dto/site.dto';

import { SITE_PAGINATION_CONFIG } from './config/site-pagination.config';

@ApiTags('Sites')
@ApiBearerAuth()
@Controller('sites')
export class SiteController {
  constructor(private readonly siteService: SiteService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get paginated sites. ADMIN sees all sites; AGENT sees assigned sites',
  })
  @ApiOkPaginatedResponse(SiteDto, SITE_PAGINATION_CONFIG)
  @ApiPaginationQuery(SITE_PAGINATION_CONFIG)
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.AGENT)
  async findAll(@Paginate() query: PaginateQuery, @Req() req: AuthRequest) {
    return this.siteService.findAll(query, req.user);
  }

  @Post()
  @ApiOperation({ summary: 'Create new site - ADMIN only' })
  @ApiBody({ type: CreateSiteDto })
  @ApiResponse({
    status: 201,
    description: 'Create site successful',
    type: SiteDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  async create(@Body() dto: CreateSiteDto, @Req() req: AuthRequest) {
    const userId = req.user.id;
    return await this.siteService.create(dto, userId);
  }
}
