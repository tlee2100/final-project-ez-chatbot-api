import {
  Body,
  Controller,
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
import type { AuthRequest } from '../auth/types/auth-request.type';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../user/enums/user-role.enum';

@ApiTags('Admin Bookings')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin/sites/:siteId/bookings')
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
    @Body()
    body: {
      staffId?: string;
      serviceId?: string;
      startAt?: string;
      endAt?: string;
      timezone?: string;
      customerName?: string;
      customerPhone?: string;
      customerEmail?: string;
      notes?: string;
    },
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
    @Body('status') status: string,
    @Req() req: AuthRequest,
  ) {
    return this.adminBookingService.updateBookingStatus(
      siteId,
      bookingId,
      status,
      req.user,
    );
  }
}
