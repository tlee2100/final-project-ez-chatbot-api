import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { McpSecretGuard } from './guards/mcp-secret.guard';
import { McpContext } from './decorators/mcp-context.decorator';
import { McpService } from './mcp.service';
import type { McpValidatedContext } from './types/mcp.types';
import {
  McpCancelBookingDto,
  McpCreateBookingDto,
  McpSearchKnowledgeDto,
  McpHoldSlotDto,
  McpReleaseHoldDto,
} from './dto/mcp-internal.dto';

/**
 * MCP-003: Internal MCP API Controller.
 *
 * All routes are protected by McpSecretGuard (X-MCP-Secret header).
 * These endpoints are ONLY for ez-mcp-server inter-service calls.
 * They must NOT be called by the widget or the admin dashboard.
 *
 * siteId is extracted from the X-MCP-Context header, which the MCP server
 * passes through after it has been validated by /auth/validate.
 */
@ApiTags('Internal MCP API')
@ApiHeader({
  name: 'X-MCP-Secret',
  description:
    'Shared secret between MCP server and backend (MCP_INTERNAL_SECRET)',
  required: true,
})
@UseGuards(McpSecretGuard)
@Controller('internal/mcp')
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  // ─── Auth ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/internal/mcp/auth/validate
   * Called by the MCP server's tokenVerifier on every incoming MCP client connection.
   * Returns the ValidatedContext payload (siteId, conversationId, authorizedActor).
   */
  @Post('auth/validate')
  @ApiOperation({ summary: 'Validate MCP session Bearer token' })
  validateToken(@Body() body: { token: string }) {
    return this.mcpService.validateToken(body.token);
  }

  /**
   * GET /api/internal/mcp/conversations/:id
   * getConversationContext tool backend.
   */
  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation context details' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async getConversationContext(
    @Param('id') conversationId: string,
    @McpContext() context: McpValidatedContext,
  ) {
    return this.mcpService.getConversationContext(
      context.siteId,
      conversationId,
    );
  }

  /**
   * GET /api/internal/mcp/users/by-email
   * getUserDetails tool backend.
   */
  @Get('users/by-email')
  @ApiOperation({ summary: 'Get user details by email' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async getUserDetails(
    @Query('email') email: string,
    @McpContext() context: McpValidatedContext,
  ) {
    const result = await this.mcpService.getUserDetails(context.siteId, email);
    // Không reveal thông tin tenant khác — trả về guest profile an toàn
    return (
      result ?? {
        email,
        name: 'Guest Visitor',
        role: 'VISITOR',
        phone: null,
      }
    );
  }

  /**
   * GET /api/internal/mcp/sites/:siteId/settings
   * getSiteConfig tool backend.
   */
  @Get('sites/:siteId/settings')
  @ApiOperation({ summary: 'Get site configuration settings' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async getSiteConfig(
    @Param('siteId') siteId: string,
    @McpContext() context: McpValidatedContext,
  ) {
    return this.mcpService.getSiteConfig(siteId || context.siteId);
  }

  // ─── Knowledge (RAG) ──────────────────────────────────────────────────────

  /**
   * POST /api/internal/mcp/kb/search
   * MCP-004: searchKnowledge tool backend.
   * Accepts query + optional topK; siteId from X-MCP-Context.
   */
  @Post('kb/search')
  @ApiOperation({ summary: 'Vector search the site knowledge base (MCP-004)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async searchKnowledge(
    @McpContext() context: McpValidatedContext,
    @Body() dto: McpSearchKnowledgeDto,
    @Query('topK') topK?: string,
  ) {
    return this.mcpService.searchKnowledge(
      dto.query,
      context.siteId,
      topK ? parseInt(topK, 10) : undefined,
    );
  }

  /**
   * GET /api/internal/mcp/kb/documents
   * MCP-005: listDocuments tool backend.
   * siteId from X-MCP-Context.
   */
  @Get('kb/documents')
  @ApiOperation({ summary: 'List KB documents for the site (MCP-005)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async listDocuments(@McpContext() context: McpValidatedContext) {
    return this.mcpService.listDocuments(context.siteId);
  }

  // ─── Booking ──────────────────────────────────────────────────────────────

  /**
   * GET /api/internal/mcp/booking/slots
   * MCP-006: getAvailableSlots tool backend.
   * siteId from X-MCP-Context; date + optional resourceId as query params.
   */
  @Get('booking/slots')
  @ApiOperation({ summary: 'Get available booking slots (MCP-006)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  @ApiQuery({
    name: 'date',
    description: 'ISO date string (YYYY-MM-DD)',
    required: true,
  })
  @ApiQuery({
    name: 'resourceId',
    description: 'Optional resource (staff) UUID',
    required: false,
  })
  @ApiQuery({
    name: 'serviceId',
    description:
      'Optional service UUID (reserved for future service-specific slot duration)',
    required: false,
  })
  async getAvailableSlots(
    @McpContext() context: McpValidatedContext,
    @Query('date') date: string,
    @Query('resourceId') resourceId?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    return await this.mcpService.getAvailableSlots(
      context.siteId,
      date,
      resourceId,
      serviceId,
    );
  }

  /**
   * POST /api/internal/mcp/booking/hold
   * MCP-009: holdSlot tool backend.
   * siteId from X-MCP-Context.
   */
  @Post('booking/hold')
  @ApiOperation({ summary: 'Hold a booking slot (MCP-009)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async holdSlot(
    @McpContext() context: McpValidatedContext,
    @Body() dto: McpHoldSlotDto,
  ) {
    return await this.mcpService.holdSlot(context.siteId, {
      ...dto,
      conversationId: context.conversationId,
    });
  }

  /**
   * POST /api/internal/mcp/booking/release
   * MCP-010: releaseHold tool backend.
   * siteId from X-MCP-Context.
   */
  @Post('booking/release')
  @ApiOperation({ summary: 'Release a held booking slot (MCP-010)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async releaseHold(
    @McpContext() context: McpValidatedContext,
    @Body() dto: McpReleaseHoldDto,
  ) {
    return await this.mcpService.releaseHold(context.siteId, {
      ...dto,
      sessionId: dto.sessionId || context.conversationId,
    });
  }

  /**
   * POST /api/internal/mcp/booking/create
   * MCP-007: createBooking tool backend.
   * siteId from X-MCP-Context.
   */
  @Post('booking/create')
  @ApiOperation({ summary: 'Create a booking (MCP-007)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async createBooking(
    @McpContext() context: McpValidatedContext,
    @Body() dto: McpCreateBookingDto,
  ) {
    return await this.mcpService.createBooking(context.siteId, dto);
  }

  /**
   * POST /api/internal/mcp/booking/cancel
   * MCP-008: cancelBooking tool backend.
   * siteId from X-MCP-Context.
   */
  @Post('booking/cancel')
  @ApiOperation({ summary: 'Cancel a booking by code (MCP-008)' })
  @ApiHeader({
    name: 'X-MCP-Context',
    description: 'Signed context carrying siteId',
    required: true,
  })
  async cancelBooking(
    @McpContext() context: McpValidatedContext,
    @Body() dto: McpCancelBookingDto,
  ) {
    return await this.mcpService.cancelBooking(context.siteId, dto.bookingCode);
  }
}
