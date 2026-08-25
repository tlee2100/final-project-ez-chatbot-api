import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Paginate } from 'nestjs-paginate';
import type { PaginateQuery } from 'nestjs-paginate';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import {
  AdminBookingService,
  UpdateBookingConfigDto,
} from './admin-booking.service';
import { HoldSlotDto } from './dto/hold-slot.dto';
import { CreateBlockoutDto } from './dto/create-blockout.dto';
import { CreateAdminBookingDto } from './dto/create-admin-booking.dto';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';
import { BulkCancelBookingsDto } from './dto/bulk-cancel-bookings.dto';
import type { AuthRequest } from '../auth/types/auth-request.type';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../user/enums/user-role.enum';

@ApiTags('Admin Bookings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Authentication token is missing or invalid',
})
@ApiForbiddenResponse({
  description: 'User lacks required role or access to this site',
})
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/bookings/:siteId')
export class AdminBookingController {
  constructor(private readonly adminBookingService: AdminBookingService) {}

  @Get('booking-config')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get booking configuration for a site' })
  @ApiOkResponse({
    description: 'Booking configuration retrieved successfully',
  })
  @ApiNotFoundResponse({ description: 'Site not found' })
  getBookingConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.adminBookingService.getBookingConfig(siteId, req.user);
  }

  @Patch('booking-config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update booking configuration for a site' })
  @ApiOkResponse({ description: 'Booking configuration updated successfully' })
  @ApiBadRequestResponse({
    description:
      'Invalid configuration or cannot delete service/resource with upcoming bookings',
  })
  @ApiNotFoundResponse({ description: 'Site not found' })
  updateBookingConfig(
    @Param('siteId') siteId: string,
    @Body() body: UpdateBookingConfigDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.updateBookingConfig(siteId, body, req.user);
  }

  @Get('available-slots')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get available slots for a site' })
  @ApiOkResponse({ description: 'Available slots retrieved successfully' })
  @ApiBadRequestResponse({ description: 'Invalid date or parameters' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  getAvailableSlots(
    @Param('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.getAvailableSlots(
      siteId,
      startDate,
      endDate,
      resourceId || null,
      req.user,
    );
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get list of bookings for a site' })
  @ApiOkResponse({ description: 'Paginated bookings retrieved successfully' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  getBookings(
    @Param('siteId') siteId: string,
    @Paginate() query: PaginateQuery,
    @Req() req: AuthRequest,
    @Query('showCancelled') showCancelled?: string,
  ) {
    return this.adminBookingService.getBookings(
      siteId,
      req.user,
      query,
      showCancelled === 'true',
    );
  }

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new manual booking' })
  @ApiCreatedResponse({ description: 'Booking successfully created' })
  @ApiBadRequestResponse({
    description: 'Invalid booking payload or missing required fields',
  })
  @ApiNotFoundResponse({ description: 'Site or service not found' })
  createBooking(
    @Param('siteId') siteId: string,
    @Body() body: CreateAdminBookingDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.createBooking(siteId, body, req.user);
  }

  @Patch(':bookingId/status')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update status of a booking' })
  @ApiOkResponse({ description: 'Booking status successfully updated' })
  @ApiBadRequestResponse({ description: 'Invalid status transition' })
  @ApiNotFoundResponse({ description: 'Site or Booking not found' })
  updateBookingStatus(
    @Param('siteId') siteId: string,
    @Param('bookingId') bookingId: string,
    @Body() body: UpdateBookingStatusDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.updateBookingStatus(
      siteId,
      bookingId,
      body.status,
      req.user,
    );
  }

  @Post('bulk-cancel')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Bulk cancel multiple bookings in a single request',
  })
  @ApiOkResponse({ description: 'Bookings successfully cancelled' })
  @ApiBadRequestResponse({ description: 'Invalid booking IDs array' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  bulkCancelBookings(
    @Param('siteId') siteId: string,
    @Body() body: BulkCancelBookingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.bulkCancelBookings(
      siteId,
      body.bookingIds,
      req.user,
    );
  }

  @Post('hold')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hold a booking slot temporarily' })
  @ApiOkResponse({ description: 'Slot successfully held' })
  @ApiBadRequestResponse({
    description: 'Invalid hold parameters or slot already reserved',
  })
  @ApiNotFoundResponse({ description: 'Site not found' })
  holdSlot(
    @Param('siteId') siteId: string,
    @Body() body: HoldSlotDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.holdSlot(siteId, body, req.user);
  }

  @Delete('hold')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release a held booking slot' })
  @ApiOkResponse({ description: 'Slot hold successfully released' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  releaseHold(
    @Param('siteId') siteId: string,
    @Body() body: HoldSlotDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.releaseHold(siteId, body, req.user);
  }

  @Get('holds')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all actively held slots for a site' })
  @ApiOkResponse({ description: 'Actively held slots retrieved successfully' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  getActiveHolds(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.adminBookingService.getActiveHolds(siteId, req.user);
  }

  @Get('blockouts')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all blockouts for a site' })
  @ApiOkResponse({ description: 'Blockouts retrieved successfully' })
  @ApiNotFoundResponse({ description: 'Site not found' })
  getBlockouts(
    @Param('siteId') siteId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.getBlockouts(
      siteId,
      req.user,
      startDate,
      endDate,
      resourceId,
    );
  }

  @Post('blockouts')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a blockout period (holiday or staff leave)',
  })
  @ApiCreatedResponse({ description: 'Blockout successfully created' })
  @ApiBadRequestResponse({
    description: 'Invalid blockout dates or parameters',
  })
  @ApiNotFoundResponse({ description: 'Site not found' })
  createBlockout(
    @Param('siteId') siteId: string,
    @Body() body: CreateBlockoutDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.createBlockout(siteId, body, req.user);
  }

  @Delete('blockouts/:blockoutId')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a blockout period' })
  @ApiNoContentResponse({ description: 'Blockout successfully deleted' })
  @ApiNotFoundResponse({ description: 'Site or Blockout not found' })
  deleteBlockout(
    @Param('siteId') siteId: string,
    @Param('blockoutId') blockoutId: string,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.deleteBlockout(
      siteId,
      blockoutId,
      req.user,
    );
  }
}
