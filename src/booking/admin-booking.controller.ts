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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/bookings/:siteId')
export class AdminBookingController {
  constructor(private readonly adminBookingService: AdminBookingService) {}

  @Get('booking-config')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @ApiOperation({ summary: 'Get booking configuration for a site' })
  getBookingConfig(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.adminBookingService.getBookingConfig(siteId, req.user);
  }

  @Patch('booking-config')
  @ApiOperation({ summary: 'Update booking configuration for a site' })
  updateBookingConfig(
    @Param('siteId') siteId: string,
    @Body() body: UpdateBookingConfigDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.updateBookingConfig(siteId, body, req.user);
  }

  @Get('available-slots')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @ApiOperation({ summary: 'Get available slots for a site' })
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
  @ApiOperation({ summary: 'Get list of bookings for a site' })
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
  createBooking(
    @Param('siteId') siteId: string,
    @Body() body: CreateAdminBookingDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.createBooking(siteId, body, req.user);
  }

  @Patch(':bookingId/status')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @ApiOperation({ summary: 'Update status of a booking' })
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
  releaseHold(
    @Param('siteId') siteId: string,
    @Body() body: HoldSlotDto,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.releaseHold(siteId, body, req.user);
  }

  @Get('holds')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @ApiOperation({ summary: 'Get all actively held slots for a site' })
  getActiveHolds(@Param('siteId') siteId: string, @Req() req: AuthRequest) {
    return this.adminBookingService.getActiveHolds(siteId, req.user);
  }

  @Get('blockouts')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.AGENT)
  @ApiOperation({ summary: 'Get all blockouts for a site' })
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
