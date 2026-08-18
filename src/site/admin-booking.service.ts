import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Site } from './entities/site.entity';
import { SiteBookingConfig } from './entities/site-booking-config.entity';
import { BookingService } from './entities/booking-service.entity';
import { BookingResource } from './entities/booking-resources.entity';

import { SiteService } from './site.service';
import type { JwtUser } from '../auth/types/jwt-user.type';
import type { PaginateQuery } from 'nestjs-paginate';
import { BookingService as CoreBookingService } from '../booking/booking.service';
import { BookingStatus } from '../booking/enums/booking-status.enum';
import { CreateBookingDto } from '../booking/dto/create-booking.dto';
import { HoldSlotDto } from '../booking/dto/hold-slot.dto';

import { IsArray, IsBoolean, IsNumber, IsString } from 'class-validator';

export class UpdateBookingConfigDto {
  @IsBoolean()
  bookingEnabled: boolean;

  @IsString()
  industryTemplate: string;

  @IsString()
  timezone: string;

  @IsNumber()
  slotDuration: number;

  @IsString()
  startTime: string;

  @IsString()
  endTime: string;

  @IsArray()
  @IsNumber({}, { each: true })
  availableDays: number[];

  @IsArray()
  @IsString({ each: true })
  services: string[];

  @IsArray()
  @IsString({ each: true })
  resources: string[];
}

@Injectable()
export class AdminBookingService {
  constructor(
    @InjectRepository(Site)
    private siteRepository: Repository<Site>,
    @InjectRepository(SiteBookingConfig)
    private configRepository: Repository<SiteBookingConfig>,
    @InjectRepository(BookingService)
    private serviceRepository: Repository<BookingService>,
    @InjectRepository(BookingResource)
    private resourceRepository: Repository<BookingResource>,
    private siteService: SiteService,
    @Inject(forwardRef(() => CoreBookingService))
    private coreBookingService: CoreBookingService,
  ) {}

  async getBookingConfig(siteId: string, user: JwtUser) {
    // 1. Authorize access
    await this.siteService.assertSiteAccess(siteId, user);
    const site = await this.siteRepository.findOne({
      where: { id: siteId },
      relations: {
        bookingConfig: true,
        bookingServices: true,
        bookingResources: true,
      },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    const config = site.bookingConfig;

    return {
      bookingEnabled: site.bookingEnabled,
      industryTemplate: site.industryTemplateId,
      timezone: config?.bookingTimezone || 'Asia/Ho_Chi_Minh',
      slotDuration: config?.bookingSlotDuration || 30,
      startTime: config?.bookingStartTime || '09:00',
      endTime: config?.bookingEndTime || '20:00',
      availableDays: config?.bookingAvailableDays || [1, 2, 3, 4, 5, 6],
      services: (site.bookingServices || []).map((s) => s.name),
      resources: (site.bookingResources || []).map((r) => r.name),
      serviceDetails: site.bookingServices || [],
      resourceDetails: site.bookingResources || [],
    };
  }

  async updateBookingConfig(
    siteId: string,
    dto: UpdateBookingConfigDto,
    user: JwtUser,
  ) {
    // 1. Authorize access
    await this.siteService.assertSiteAccess(siteId, user);

    const site = await this.siteRepository.findOne({
      where: { id: siteId },
      relations: {
        bookingConfig: true,
        bookingServices: true,
        bookingResources: true,
      },
    });

    if (!site) {
      throw new NotFoundException('Site not found');
    }

    // 1. Update Site fields
    site.bookingEnabled = dto.bookingEnabled;
    site.industryTemplateId = dto.industryTemplate;

    // 2. Upsert Config
    if (!site.bookingConfig) {
      site.bookingConfig = this.configRepository.create({ siteId });
    }
    site.bookingConfig.bookingTimezone = dto.timezone;
    site.bookingConfig.bookingSlotDuration = dto.slotDuration;
    site.bookingConfig.bookingStartTime = dto.startTime;
    site.bookingConfig.bookingEndTime = dto.endTime;
    site.bookingConfig.bookingAvailableDays = dto.availableDays;

    // 3. Sync Services (Smart Upsert)
    const existingServices = site.bookingServices || [];
    const newServiceNames = dto.services || [];
    const servicesToRemove = existingServices.filter(
      (s) => !newServiceNames.includes(s.name),
    );
    const servicesToKeep = existingServices.filter((s) =>
      newServiceNames.includes(s.name),
    );
    const serviceNamesToKeep = servicesToKeep.map((s) => s.name);
    const servicesToAdd = newServiceNames
      .filter((name) => !serviceNamesToKeep.includes(name))
      .map((name) => this.serviceRepository.create({ siteId, name }));

    if (servicesToRemove.length > 0) {
      for (const service of servicesToRemove) {
        const hasActive = await this.siteService.hasActiveBookingsForService(
          siteId,
          service.id,
        );
        if (hasActive) {
          throw new BadRequestException(
            `Cannot delete service "${service.name}" because it has active bookings.`,
          );
        }
      }
      await this.serviceRepository.remove(servicesToRemove);
    }
    site.bookingServices = [...servicesToKeep, ...servicesToAdd];

    // 4. Sync Resources (Smart Upsert)
    const existingResources = site.bookingResources || [];
    const newResourceNames = dto.resources || [];
    const resourcesToRemove = existingResources.filter(
      (r) => !newResourceNames.includes(r.name),
    );
    const resourcesToKeep = existingResources.filter((r) =>
      newResourceNames.includes(r.name),
    );
    const resourceNamesToKeep = resourcesToKeep.map((r) => r.name);
    const resourcesToAdd = newResourceNames
      .filter((name) => !resourceNamesToKeep.includes(name))
      .map((name) => this.resourceRepository.create({ siteId, name }));

    if (resourcesToRemove.length > 0) {
      for (const resource of resourcesToRemove) {
        const hasActive = await this.siteService.hasActiveBookingsForResource(
          siteId,
          resource.id,
        );
        if (hasActive) {
          throw new BadRequestException(
            `Cannot delete staff "${resource.name}" because they have active bookings.`,
          );
        }
      }
      await this.resourceRepository.remove(resourcesToRemove);
    }
    site.bookingResources = [...resourcesToKeep, ...resourcesToAdd];

    await this.siteRepository.save(site);

    return this.getBookingConfig(siteId, user);
  }

  async getBookings(
    siteId: string,
    user: JwtUser,
    query: PaginateQuery,
    showCancelled?: boolean,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.getBookingsPaginated(
      siteId,
      query,
      showCancelled,
    );
  }

  async getActiveHolds(siteId: string, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.getActiveHolds(siteId);
  }

  async releaseHold(siteId: string, dto: HoldSlotDto, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.releaseHold(siteId, dto);
  }

  async createBooking(
    siteId: string,
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
      sessionId: string;
    },
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);

    const dto = {
      siteId,
      resourceId: body.staffId,
      serviceId: body.serviceId,
      startAt: body.startAt,
      endAt: body.endAt,
      timezone: body.timezone || 'UTC',
      customerName: body.customerName,
      phone: body.customerPhone,
      customerEmail: body.customerEmail,
      notes: body.notes,
      sessionId: body.sessionId,
    };

    return this.coreBookingService.createBooking(
      dto as unknown as CreateBookingDto,
    );
  }

  async updateBookingStatus(
    siteId: string,
    bookingId: string,
    status: string,
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.updateBookingStatus(
      siteId,
      bookingId,
      status as BookingStatus,
    );
  }

  async getAvailableSlots(
    siteId: string,
    startDate: string,
    endDate: string,
    resourceId: string | null,
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.getAvailableSlots(
      siteId,
      resourceId,
      null,
      startDate,
      endDate,
    );
  }

  async holdSlot(siteId: string, dto: HoldSlotDto, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.holdSlot(siteId, dto);
  }
}
