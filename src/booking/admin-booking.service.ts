import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Site } from '../site/entities/site.entity';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingServiceItem } from '../site/entities/booking-service.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { Booking } from './entities/booking.entity';

import { SiteService } from '../site/site.service';
import type { JwtUser } from '../auth/types/jwt-user.type';
import type { PaginateQuery } from 'nestjs-paginate';
import { BookingService as CoreBookingService } from './booking.service';
import { BookingStatus } from './enums/booking-status.enum';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CreateAdminBookingDto } from './dto/create-admin-booking.dto';
import { CreateBlockoutDto } from './dto/create-blockout.dto';
import { HoldSlotDto } from './dto/hold-slot.dto';

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
    @InjectRepository(BookingServiceItem)
    private serviceRepository: Repository<BookingServiceItem>,
    @InjectRepository(BookingResource)
    private resourceRepository: Repository<BookingResource>,
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    private siteService: SiteService,
    private dataSource: DataSource,
    private coreBookingService: CoreBookingService,
  ) {}

  async hasActiveBookingsForService(
    siteId: string,
    serviceId: string,
  ): Promise<boolean> {
    const count = await this.bookingRepository.count({
      where: {
        siteId,
        serviceId,
        status: In([BookingStatus.CONFIRMED]),
      },
    });
    return count > 0;
  }

  async hasActiveBookingsForResource(
    siteId: string,
    resourceId: string,
  ): Promise<boolean> {
    const count = await this.bookingRepository.count({
      where: {
        siteId,
        resourceId,
        status: In([BookingStatus.CONFIRMED]),
      },
    });
    return count > 0;
  }

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

    // Wrap multi-table sync inside an ACID database transaction
    await this.dataSource.transaction(async (manager) => {
      const siteRepo = manager.getRepository(Site);
      const configRepo = manager.getRepository(SiteBookingConfig);
      const serviceRepo = manager.getRepository(BookingServiceItem);
      const resourceRepo = manager.getRepository(BookingResource);

      // 1. Update Site fields
      site.bookingEnabled = dto.bookingEnabled;
      site.industryTemplateId = dto.industryTemplate;

      // 2. Upsert Config
      if (!site.bookingConfig) {
        site.bookingConfig = configRepo.create({ siteId });
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
        .map((name) => serviceRepo.create({ siteId, name }));

      if (servicesToRemove.length > 0) {
        for (const service of servicesToRemove) {
          const hasActive = await this.hasActiveBookingsForService(
            siteId,
            service.id,
          );
          if (hasActive) {
            throw new BadRequestException(
              `Cannot delete service "${service.name}" because it has upcoming confirmed bookings.`,
            );
          }
        }
        await serviceRepo.remove(servicesToRemove);
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
        .map((name) => resourceRepo.create({ siteId, name }));

      if (resourcesToRemove.length > 0) {
        for (const resource of resourcesToRemove) {
          const hasActive = await this.hasActiveBookingsForResource(
            siteId,
            resource.id,
          );
          if (hasActive) {
            throw new BadRequestException(
              `Cannot delete staff/resource "${resource.name}" because it has upcoming confirmed bookings.`,
            );
          }
        }
        await resourceRepo.remove(resourcesToRemove);
      }
      site.bookingResources = [...resourcesToKeep, ...resourcesToAdd];

      await siteRepo.save(site);
    });

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
    body: CreateAdminBookingDto,
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);

    const dto = {
      siteId,
      resourceId: body.staffId,
      serviceId: body.serviceId,
      serviceIds: body.serviceIds,
      slots: body.slots,
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
    status: BookingStatus,
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.updateBookingStatus(
      siteId,
      bookingId,
      status,
    );
  }

  async bulkCancelBookings(
    siteId: string,
    bookingIds: string[],
    user: JwtUser,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.bulkCancelBookings(siteId, bookingIds);
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

  async getBlockouts(
    siteId: string,
    user: JwtUser,
    startDate?: string,
    endDate?: string,
    resourceId?: string,
  ) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.getBlockouts(
      siteId,
      startDate,
      endDate,
      resourceId,
    );
  }

  async createBlockout(siteId: string, dto: CreateBlockoutDto, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.createBlockout(siteId, dto);
  }

  async deleteBlockout(siteId: string, blockoutId: string, user: JwtUser) {
    await this.siteService.assertSiteAccess(siteId, user);
    return this.coreBookingService.deleteBlockout(siteId, blockoutId);
  }
}
