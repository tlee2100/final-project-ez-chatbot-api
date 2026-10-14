import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { UserRole } from '../user/enums/user-role.enum';
import { OrganizationService } from './organization.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { QueryOrganizationDto } from './dto/query-organization.dto';
import {
  DeleteOrganizationResponseDto,
  OrganizationResponseDto,
  PaginatedOrganizationsDto,
} from './dto/organization-response.dto';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
@UseInterceptors(ClassSerializerInterceptor)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  @ApiOperation({
    summary: 'Get organizations with pagination, filtering and sorting',
    description:
      'SUPER_ADMIN and ADMIN. Supports name/slug filters and allowlisted sorting.',
  })
  @ApiResponse({
    status: 200,
    description: 'Organizations retrieved successfully',
    type: PaginatedOrganizationsDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  findAll(
    @Query() query: QueryOrganizationDto,
    @Req() req: AuthRequest,
  ): Promise<PaginatedOrganizationsDto> {
    return this.organizationService.findAll(query, req.user);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new organization',
    description: 'SUPER_ADMIN only. Slug must be globally unique.',
  })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiResponse({
    status: 201,
    description: 'Organization created successfully',
    type: OrganizationResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 409, description: 'Organization slug already exists' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  create(
    @Body() createOrganizationDto: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return this.organizationService.create(createOrganizationDto);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get organization by ID',
    description: 'SUPER_ADMIN and ADMIN.',
  })
  @ApiParam({
    name: 'id',
    description: 'Organization ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization retrieved successfully',
    type: OrganizationResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  @UseGuards(JwtAuthGuard)
  findOne(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<OrganizationResponseDto> {
    return this.organizationService.findOne(id, req.user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update organization',
    description: 'SUPER_ADMIN and ADMIN. Slug must remain globally unique.',
  })
  @ApiParam({
    name: 'id',
    description: 'Organization ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiBody({ type: UpdateOrganizationDto })
  @ApiResponse({
    status: 200,
    description: 'Organization updated successfully',
    type: OrganizationResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  @ApiResponse({ status: 409, description: 'Organization slug already exists' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  update(
    @Param('id') id: string,
    @Body() updateOrganizationDto: UpdateOrganizationDto,
    @Req() req: AuthRequest,
  ): Promise<OrganizationResponseDto> {
    return this.organizationService.update(id, updateOrganizationDto, req.user);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete organization',
    description:
      'SUPER_ADMIN and ADMIN (Owner only). Delete is blocked while the organization has users or sites.',
  })
  @ApiParam({
    name: 'id',
    description: 'Organization ID',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @ApiResponse({
    status: 200,
    description: 'Organization deleted successfully',
    type: DeleteOrganizationResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Organization not found' })
  @ApiResponse({
    status: 409,
    description: 'Organization has users or sites',
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ): Promise<DeleteOrganizationResponseDto> {
    return this.organizationService.remove(id, req.user);
  }
}
