import {
  Body,
  Controller,
  Post,
  Put,
  Req,
  UseGuards,
  Get,
  Patch,
  Delete,
  Param,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { SiteService } from './site.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
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
  ApiParam,
} from '@nestjs/swagger';
import type { AuthRequest } from 'src/auth/types/auth-request.type';
import { SiteDto } from './dto/site.dto';
import { AssignAgentDto } from './dto/assign-agent.dto';

import { ChatGateway } from '../chat/chat.gateway';
import { SITE_PAGINATION_CONFIG } from './config/site-pagination.config';
import { BookingService } from '../booking/booking.service';
import { formatInTimeZone } from 'date-fns-tz';

@ApiTags('Sites')
@ApiBearerAuth()
@Controller('sites')
export class SiteController {
  constructor(
    private readonly siteService: SiteService,
    private readonly chatGateway: ChatGateway,
    private readonly bookingService: BookingService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create new site - ADMIN only' })
  @ApiBody({ type: CreateSiteDto })
  @ApiResponse({
    status: 201,
    description: 'Create site successful',
    type: SiteDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  async create(@Body() dto: CreateSiteDto, @Req() req: AuthRequest) {
    return await this.siteService.create(dto, req.user);
  }

  @Get()
  @ApiOperation({
    summary:
      'Get paginated sites. SUPER_ADMIN sees all; ADMIN/AGENT see only sites in their own organization (agents further limited to assigned sites)',
  })
  @ApiOkPaginatedResponse(SiteDto, SITE_PAGINATION_CONFIG)
  @ApiPaginationQuery(SITE_PAGINATION_CONFIG)
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  async findAll(@Paginate() query: PaginateQuery, @Req() req: AuthRequest) {
    return this.siteService.findAll(query, req.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single site by ID (org-scoped)' })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiResponse({ status: 200, type: SiteDto })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — site outside your organization',
  })
  @ApiResponse({ status: 404, description: 'Site not found' })
  @UseGuards(AuthGuard('jwt'))
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.findOneWithAccess(id, req.user);
  }

  @Get('public/:id')
  @ApiOperation({
    summary: 'Get public site info for visitors (Unauthenticated)',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiResponse({ status: 200, description: 'Public site info' })
  @ApiResponse({ status: 404, description: 'Site not found' })
  async getPublicSiteInfo(@Param('id', ParseUUIDPipe) id: string) {
    const site = await this.siteService.findOneEntity(id);
    return {
      id: site.id,
      name: site.name,
      isEnabled: site.enabled,
      enabled: site.enabled,
      isAiActive: site.isAiActive,
      useCurrentPageContent: site.useCurrentPageContent,
      allowedDomains: site.allowedDomains ?? [],
      enableConversationTimeout: site.enableConversationTimeout,
      inactivityTimeoutMinutes: site.inactivityTimeoutMinutes,
      warningTimeMinutes: site.warningTimeMinutes,
      inactivityWarningMessage: site.inactivityWarningMessage,
      timeoutMessage: site.timeoutMessage,
      resetTimerOnBotResponse: site.resetTimerOnBotResponse,
      pauseTimerForAgentChats: site.pauseTimerForAgentChats,
      sendEmailNotificationOnTimeout: site.sendEmailNotificationOnTimeout,
      primaryColor: site.primaryColor,
      backgroundColor: site.backgroundColor,
      botAvatar: site.botAvatar,
      launcherIcon: site.launcherIcon,
      defaultGreetingMessage: site.defaultGreetingMessage,
      chatButtonPosition: site.chatButtonPosition,
      chatWindowTitle: site.chatWindowTitle,
      chatButtonText: site.chatButtonText,
      showAvatar: site.showAvatar,
      humanHandoff: site.humanHandoff,
      emailTranscript: site.emailTranscript,
      bookingEnabled: site.bookingEnabled,
      industryTemplate: site.industryTemplateId ?? 'salon',
      industryTemplateConfig: site.industryTemplateInfo?.config ?? null,
      bookingServices:
        site.bookingServices?.map((s) => ({
          id: s.id,
          name: s.name,
        })) ?? [],
      bookingResources:
        site.bookingResources?.map((r) => ({
          id: r.id,
          name: r.name,
        })) ?? [],
      bookingHours: site.bookingConfig
        ? {
            timezone: site.bookingConfig.bookingTimezone,
            availableDays: site.bookingConfig.bookingAvailableDays,
            startTime: site.bookingConfig.bookingStartTime,
            endTime: site.bookingConfig.bookingEndTime,
            slotDuration: site.bookingConfig.bookingSlotDuration,
          }
        : null,
    };
  }

  @Get('public/:id/available-slots')
  @ApiOperation({
    summary: 'Get available booking slots for a date (Unauthenticated)',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  async getPublicAvailableSlots(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('date') date: string,
    @Query('resourceId') resourceId?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    if (!date) {
      throw new BadRequestException('date parameter is required');
    }
    const config = await this.bookingService.getSiteBookingConfig(id);
    const timezone = config.bookingTimezone || 'UTC';

    const result = await this.bookingService.getAvailableSlots(
      id,
      resourceId || null,
      serviceId || null,
      date,
      date,
    );

    const slots = result.slots.map((slot, idx) => {
      const localTime = formatInTimeZone(
        new Date(slot.startAt),
        timezone,
        'HH:mm',
      );
      const slotId = `slot-${date}-${idx}`;

      if ('availableResources' in slot && slot.availableResources) {
        return {
          slotId,
          date,
          timeSlot: localTime,
          availableResources: slot.availableResources,
          available: slot.availableResources.length > 0,
        };
      }

      const s = slot as { startAt: string; endAt: string; resourceId: string };
      return {
        slotId,
        date,
        timeSlot: localTime,
        resourceId: s.resourceId ?? resourceId ?? 'any',
        available: true,
      };
    });

    return { slots };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update site (Owner or ADMIN/SUPER_ADMIN only)' })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiBody({ type: UpdateSiteDto })
  @ApiResponse({ status: 200, type: SiteDto })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'))
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSiteDto,
    @Req() req: AuthRequest,
  ) {
    const updated = await this.siteService.update(id, dto, req.user);
    this.chatGateway.server
      .to(`site-${id}`)
      .to(`site-settings-${id}`)
      .emit('siteSettingsUpdated', updated);
    return updated;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete site (Owner or ADMIN/SUPER_ADMIN only)' })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiResponse({ status: 204, description: 'Site deleted successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'))
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.remove(id, req.user);
  }

  @Post(':id/image')
  @ApiOperation({
    summary:
      'Upload an image (avatar or launcher icon) for a site (Owner or ADMIN/SUPER_ADMIN only)',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Image uploaded successfully' })
  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(FileInterceptor('file'))
  async uploadImage(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthRequest,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    const result = await this.siteService.uploadImage(id, file, req.user);
    return { url: result.secure_url };
  }

  @Post(':id/agents')
  @ApiOperation({
    summary: 'Assign an agent to a site (ADMIN/SUPER_ADMIN only)',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiBody({ type: AssignAgentDto })
  @ApiResponse({ status: 201, type: SiteDto })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async assignAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignAgentDto,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.assignAgent(id, dto.agentId, req.user);
  }

  @Delete(':id/agents/:agentId')
  @ApiOperation({
    summary: 'Remove an agent from a site (ADMIN/SUPER_ADMIN only)',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiParam({ name: 'agentId', description: 'Agent ID' })
  @ApiResponse({ status: 200, type: SiteDto })
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  async removeAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.removeAgent(id, agentId, req.user);
  }

  // ── BYOK — Bring Your Own Key (SEC-001 / CE-004) ──────────────────────────

  @Put(':id/api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Validate and save custom AI provider credentials (API key, Base URL, Model) for this site. Key is AES-256-GCM encrypted before storage.',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          description:
            'Raw API key (e.g. sk-...). If omitted, validates and uses existing stored key.',
        },
        customBaseUrl: {
          type: 'string',
          description:
            'Optional custom provider URL (e.g. https://api.openai.com/v1)',
        },
        llmModel: {
          type: 'string',
          description:
            'Optional LLM model name (e.g. gpt-4o-mini, qwen3.7-flash)',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Key verified and saved successfully. Returns { useCustomOpenAiKey, customKeyStatus, customBaseUrl, keyMask, llmModel, warning? }',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or unauthorized API key or model provided',
  })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'))
  async saveCustomApiKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('apiKey') apiKey: string | undefined,
    @Body('customBaseUrl') customBaseUrl: string | undefined,
    @Body('llmModel') llmModel: string | undefined,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.saveCustomApiKey(
      id,
      req.user,
      apiKey,
      customBaseUrl,
      llmModel,
    );
  }

  @Post(':id/api-key/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Test connection to AI provider on-demand without saving credentials. If apiKey is omitted, tests existing stored key.',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: 'Optional API key to test' },
        customBaseUrl: {
          type: 'string',
          description: 'Optional custom Base URL to test',
        },
        llmModel: {
          type: 'string',
          description: 'Optional model name to test',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Returns connection test results { valid, latencyMs, customKeyStatus, endpointTested, warning?, error? }',
  })
  @ApiResponse({ status: 400, description: 'No key available to test' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'))
  async testCustomApiKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('apiKey') apiKey: string | undefined,
    @Body('customBaseUrl') customBaseUrl: string | undefined,
    @Body('llmModel') llmModel: string | undefined,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.testCustomApiKeyConnection(id, req.user, {
      apiKey,
      customBaseUrl,
      llmModel,
    });
  }

  @Delete(':id/api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Remove the custom OpenAI API key for this site, reverting to the shared master key.',
  })
  @ApiParam({ name: 'id', description: 'Site ID' })
  @ApiResponse({ status: 200, description: 'Key removed successfully' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @UseGuards(AuthGuard('jwt'))
  async removeCustomApiKey(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.siteService.removeCustomApiKey(id, req.user);
  }
}
