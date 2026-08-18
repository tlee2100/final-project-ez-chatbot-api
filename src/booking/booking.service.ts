import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Booking } from './entities/booking.entity';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { BookingService as BookingServiceEntity } from '../site/entities/booking-service.entity';
import { Repository } from 'typeorm';
import { CreateBookingDto } from './dto/create-booking.dto';
import { SiteService } from '../site/site.service';
import { EmailQueueService } from '../notification/email-queue.service';
import { BookingStatus } from './enums/booking-status.enum';
import {
  addMinutes,
  format,
  isAfter,
  isBefore,
  isEqual,
  parseISO,
  startOfDay,
  endOfDay,
  getDay,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  paginate,
  FilterOperator,
  PaginateQuery,
  Paginated,
} from 'nestjs-paginate';

@Injectable()
export class BookingService {
  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(SiteBookingConfig)
    private configRepository: Repository<SiteBookingConfig>,
    @InjectRepository(BookingResource)
    private resourceRepository: Repository<BookingResource>,
    @InjectRepository(BookingServiceEntity)
    private serviceEntityRepository: Repository<BookingServiceEntity>,
    private siteService: SiteService,
    private emailQueueService: EmailQueueService,
  ) {}

  async getSiteBookingConfig(siteId: string): Promise<SiteBookingConfig> {
    const config = await this.configRepository.findOne({ where: { siteId } });
    if (!config) {
      throw new NotFoundException('Site booking configuration not found');
    }
    return config;
  }

  async getResourceById(
    siteId: string,
    resourceId: string,
  ): Promise<BookingResource | null> {
    return this.resourceRepository.findOne({
      where: { id: resourceId, siteId },
    });
  }

  async getServiceById(
    siteId: string,
    serviceId: string,
  ): Promise<BookingServiceEntity | null> {
    return this.serviceEntityRepository.findOne({
      where: { id: serviceId, siteId },
    });
  }

  async getServicesBySiteId(siteId: string): Promise<BookingServiceEntity[]> {
    return this.serviceEntityRepository.find({
      where: { siteId },
    });
  }

  async getResourcesBySiteId(siteId: string): Promise<BookingResource[]> {
    return this.resourceRepository.find({
      where: { siteId },
    });
  }

  async getAvailableSlots(
    siteId: string,
    resourceId: string | null,
    serviceId: string | null,
    startDate: string,
    endDate: string,
  ) {
    const config = await this.configRepository.findOne({ where: { siteId } });
    if (!config) {
      throw new NotFoundException('Site booking configuration not found');
    }

    const timezone = config.bookingTimezone || 'UTC';
    const duration = config.bookingSlotDuration || 30;

    let allResources: BookingResource[] = [];
    if (!resourceId) {
      allResources = await this.resourceRepository.find({ where: { siteId } });
    }

    const requestedStart = parseISO(startDate);
    const todayInSiteTimezone = formatInTimeZone(
      new Date(),
      timezone,
      'yyyy-MM-dd',
    );
    const startBoundary =
      startDate === todayInSiteTimezone ? new Date() : requestedStart;
    const endBoundary = endOfDay(parseISO(endDate));

    // Fetch bookings in this range
    const bookingsQuery = this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.siteId = :siteId', { siteId })
      .andWhere('booking.status != :cancelled', {
        cancelled: BookingStatus.CANCELLED,
      })
      .andWhere('booking.endAt >= :startBoundary', { startBoundary })
      .andWhere('booking.startAt <= :endBoundary', { endBoundary });

    if (resourceId) {
      bookingsQuery.andWhere(
        'COALESCE("booking"."resourceId"::text, \'___NULL___\') = COALESCE(:resourceId::text, \'___NULL___\')',
        { resourceId },
      );
    }

    const bookings = await bookingsQuery.getMany();

    type SlotItem =
      | { startAt: string; endAt: string; resourceId: string }
      | {
          startAt: string;
          endAt: string;
          availableResources: Array<{
            resourceId: string;
            resourceName: string;
          }>;
        };
    const availableSlots: SlotItem[] = [];

    // We'll iterate day by day. To keep things simple, let's just generate slots for each day in the requested range.
    let currentDay = startOfDay(startBoundary);

    while (!isAfter(currentDay, endBoundary)) {
      // getDay: 0 = Sunday, 1 = Monday. Config array: default {1,2,3,4,5} (Mon-Fri)
      const dayOfWeek = getDay(currentDay) === 0 ? 7 : getDay(currentDay);
      if (config.bookingAvailableDays.includes(dayOfWeek)) {
        // Parse start and end time for this specific day in the site's local timezone
        const dateStr = format(currentDay, 'yyyy-MM-dd');
        const dayStartTimeStr = `${dateStr}T${config.bookingStartTime}:00`;
        const dayEndTimeStr = `${dateStr}T${config.bookingEndTime}:00`;

        // Convert the local time strings into absolute UTC Date objects using the site's timezone
        let slotStart = fromZonedTime(dayStartTimeStr, timezone);
        const dayEnd = fromZonedTime(dayEndTimeStr, timezone);
        let slotEnd = addMinutes(slotStart, duration);

        while (isBefore(slotStart, dayEnd) || isEqual(slotStart, dayEnd)) {
          const now = new Date();
          if (
            slotStart >= startBoundary &&
            slotEnd <= endBoundary &&
            slotStart >= now
          ) {
            if (resourceId) {
              // Check if slot overlaps with any booking for this specific resource
              const isOverlapping = bookings.some((b) => {
                const bStart = new Date(b.startAt);
                const bEnd = new Date(b.endAt);
                return slotStart < bEnd && slotEnd > bStart;
              });

              if (!isOverlapping) {
                availableSlots.push({
                  startAt: slotStart.toISOString(),
                  endAt: slotEnd.toISOString(),
                  resourceId,
                });
              }
            } else {
              // No preference: find all resources that are free
              const freeResources = allResources.filter((resource) => {
                const isOverlapping = bookings.some((b) => {
                  const bStart = new Date(b.startAt);
                  const bEnd = new Date(b.endAt);
                  return (
                    slotStart < bEnd &&
                    slotEnd > bStart &&
                    b.resourceId === resource.id
                  );
                });
                return !isOverlapping;
              });

              if (freeResources.length > 0) {
                availableSlots.push({
                  startAt: slotStart.toISOString(),
                  endAt: slotEnd.toISOString(),
                  availableResources: freeResources.map((r) => ({
                    resourceId: r.id,
                    resourceName: r.name,
                  })),
                });
              }
            }
          }

          slotStart = slotEnd;
          slotEnd = addMinutes(slotStart, duration);
        }
      }
      currentDay = addMinutes(currentDay, 24 * 60); // next day
    }

    return { slots: availableSlots };
  }

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    const bookingDate = new Date(dto.startAt);

    // Prevent booking for days before today
    if (isBefore(startOfDay(bookingDate), startOfDay(new Date()))) {
      throw new BadRequestException('Cannot create a booking for a past day');
    }
    // Layer 2 Security: Pre-check SELECT for overlaps
    const conflictQuery = this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.siteId = :siteId', { siteId: dto.siteId })
      .andWhere('booking.status != :cancelled', {
        cancelled: BookingStatus.CANCELLED,
      })
      .andWhere(
        'COALESCE("booking"."resourceId"::text, \'___NULL___\') = COALESCE(:resourceId::text, \'___NULL___\')',
        { resourceId: dto.resourceId || null },
      )
      .andWhere(
        'tstzrange("booking"."startAt", "booking"."endAt") && tstzrange(:startAt::timestamptz, :endAt::timestamptz)',
        {
          startAt: dto.startAt,
          endAt: dto.endAt,
        },
      )
      .limit(1);

    const existingConflict = await conflictQuery.getOne();
    if (existingConflict) {
      throw new ConflictException(
        'Slot no longer available. Please select another time.',
      );
    }

    // Generate a code, for simplicity we can use a random short string
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();

    const booking = this.bookingRepository.create({
      ...dto,
      code,
      status: BookingStatus.CONFIRMED,
    });

    try {
      const savedBooking = await this.bookingRepository.save(booking);

      if (savedBooking.customerEmail) {
        const site = await this.siteService.findOne(dto.siteId);
        const service = dto.serviceId
          ? await this.getServiceById(dto.siteId, dto.serviceId)
          : null;
        const resource = dto.resourceId
          ? await this.getResourceById(dto.siteId, dto.resourceId)
          : null;

        void this.emailQueueService.enqueueBookingConfirmationEmail({
          to: savedBooking.customerEmail,
          customerName: savedBooking.customerName,
          bookingCode: savedBooking.code,
          serviceName: service?.name ?? 'N/A',
          resourceName: resource?.name ?? null,
          startAt: new Date(savedBooking.startAt).toISOString(),
          endAt: new Date(savedBooking.endAt).toISOString(),
          timezone: savedBooking.timezone,
          siteName: site.name,
        });
      }

      return savedBooking;
    } catch (error: unknown) {
      // Layer 1 Security Fallback: Catch PostgreSQL GiST exception
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as Record<string, unknown>).code === '23P01'
      ) {
        throw new ConflictException(
          'Slot no longer available. Please select another time.',
        );
      }
      throw error;
    }
  }

  async getBookingsPaginated(
    siteId: string,
    query: PaginateQuery,
    showCancelled?: boolean,
  ): Promise<Paginated<Booking>> {
    const qb = this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoinAndSelect('booking.service', 'service')
      .leftJoinAndSelect('booking.resource', 'resource')
      .where('booking.siteId = :siteId', { siteId });

    if (!showCancelled) {
      qb.andWhere('booking.status != :cancelledStatus', {
        cancelledStatus: BookingStatus.CANCELLED,
      });
    }

    return paginate(query, qb, {
      sortableColumns: ['startAt', 'endAt', 'status', 'customerName', 'phone'],
      defaultSortBy: [['startAt', 'DESC']],
      searchableColumns: ['customerName', 'phone', 'customerEmail', 'code'],
      filterableColumns: {
        status: [FilterOperator.EQ, FilterOperator.IN],
        'resource.id': [FilterOperator.EQ],
        startAt: [FilterOperator.GTE, FilterOperator.LTE],
      },
    });
  }

  async getBookings(
    siteId: string,
    filters: {
      status?: BookingStatus;
      startDate?: string;
      endDate?: string;
      resourceId?: string;
    } = {},
  ): Promise<Booking[]> {
    const query = this.bookingRepository
      .createQueryBuilder('booking')
      .leftJoinAndSelect('booking.service', 'service')
      .leftJoinAndSelect('booking.resource', 'resource')
      .where('booking.siteId = :siteId', { siteId });

    if (filters.status) {
      query.andWhere('booking.status = :status', { status: filters.status });
    }
    if (filters.startDate) {
      query.andWhere('booking.startAt >= :startDate', {
        startDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      query.andWhere('booking.startAt <= :endDate', {
        endDate: filters.endDate,
      });
    }
    if (filters.resourceId) {
      query.andWhere('booking.resourceId = :resourceId', {
        resourceId: filters.resourceId,
      });
    }

    query.orderBy('booking.startAt', 'ASC');

    return query.getMany();
  }

  async getBookingById(siteId: string, bookingId: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { id: bookingId, siteId },
      relations: { service: true, resource: true },
    });

    if (!booking) {
      throw new NotFoundException(`Booking with ID ${bookingId} not found`);
    }
    return booking;
  }

  async getBookingByCode(siteId: string, code: string): Promise<Booking> {
    const booking = await this.bookingRepository.findOne({
      where: { code, siteId },
      relations: { service: true, resource: true },
    });

    if (!booking) {
      throw new NotFoundException(`Booking with code ${code} not found`);
    }
    return booking;
  }

  async updateBookingStatus(
    siteId: string,
    bookingId: string,
    status: BookingStatus,
  ): Promise<Booking> {
    const booking = await this.getBookingById(siteId, bookingId);

    if (booking.status === BookingStatus.COMPLETED) {
      throw new ConflictException(
        'Cannot update status of a completed booking',
      );
    }
    if (booking.status === BookingStatus.CANCELLED) {
      throw new ConflictException(
        'Cannot update status of a cancelled booking',
      );
    }

    booking.status = status;
    const savedBooking = await this.bookingRepository.save(booking);

    if (status === BookingStatus.CANCELLED && savedBooking.customerEmail) {
      const site = await this.siteService.findOne(siteId);
      const service = savedBooking.serviceId
        ? await this.getServiceById(siteId, savedBooking.serviceId)
        : null;
      const resource = savedBooking.resourceId
        ? await this.getResourceById(siteId, savedBooking.resourceId)
        : null;

      void this.emailQueueService.enqueueBookingCancellationEmail({
        to: savedBooking.customerEmail,
        customerName: savedBooking.customerName,
        bookingCode: savedBooking.code,
        serviceName: service?.name ?? 'N/A',
        resourceName: resource?.name ?? null,
        startAt: new Date(savedBooking.startAt).toISOString(),
        timezone: savedBooking.timezone,
        siteName: site.name,
      });
    }

    return savedBooking;
  }

  async cancelBooking(siteId: string, bookingId: string): Promise<Booking> {
    return this.updateBookingStatus(siteId, bookingId, BookingStatus.CANCELLED);
  }

  async getBookingTimeline(siteId: string, bookingId: string) {
    const booking = await this.getBookingById(siteId, bookingId);

    // Stub implementation as we don't have a timeline entity yet
    return {
      bookingId: booking.id,
      events: [
        {
          type: 'CREATED',
          timestamp: booking.createdAt,
          description: 'Booking was created',
        },
        {
          type: 'STATUS_UPDATED',
          timestamp: booking.updatedAt,
          description: `Booking status is ${booking.status}`,
        },
      ],
    };
  }
}
