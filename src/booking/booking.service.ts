import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Booking } from './entities/booking.entity';
import { BookingBlockout } from './entities/booking-blockout.entity';
import { SiteBookingConfig } from '../site/entities/site-booking-config.entity';
import { BookingResource } from '../site/entities/booking-resources.entity';
import { BookingServiceItem } from '../site/entities/booking-service.entity';
import { Repository } from 'typeorm';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CreateBlockoutDto } from './dto/create-blockout.dto';
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
  getDay,
} from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import {
  paginate,
  FilterOperator,
  PaginateQuery,
  Paginated,
} from 'nestjs-paginate';
import { Redis } from 'ioredis';
import { BookingGateway } from './booking.gateway';
import { HoldSlotDto } from './dto/hold-slot.dto';
import { groupConsecutiveSlots } from './booking-slot.utils';

export type SlotItem =
  | {
      startAt: string;
      endAt: string;
      resourceId: string;
      status: 'AVAILABLE' | 'HOLDING' | 'BOOKED';
    }
  | {
      startAt: string;
      endAt: string;
      status: 'AVAILABLE' | 'HOLDING' | 'BOOKED';
      availableResources: Array<{
        resourceId: string;
        resourceName: string;
      }>;
    };
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectRepository(Booking)
    private bookingRepository: Repository<Booking>,
    @InjectRepository(BookingBlockout)
    private blockoutRepository: Repository<BookingBlockout>,
    @InjectRepository(SiteBookingConfig)
    private configRepository: Repository<SiteBookingConfig>,
    @InjectRepository(BookingResource)
    private resourceRepository: Repository<BookingResource>,
    @InjectRepository(BookingServiceItem)
    private serviceEntityRepository: Repository<BookingServiceItem>,
    @Inject(forwardRef(() => SiteService))
    private siteService: SiteService,
    private emailQueueService: EmailQueueService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly bookingGateway: BookingGateway,
  ) {}

  private buildHoldKey(
    siteId: string,
    resourceId: string,
    startAt: string,
    endAt: string,
  ): string {
    return `booking_hold:site:${siteId}:resource:${resourceId}:time:${startAt}_${endAt}`;
  }

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
  ): Promise<BookingServiceItem | null> {
    return this.serviceEntityRepository.findOne({
      where: { id: serviceId, siteId },
    });
  }

  async getServicesBySiteId(siteId: string): Promise<BookingServiceItem[]> {
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
    startDate?: string,
    endDate?: string,
  ) {
    const site = await this.siteService.findOneEntity(siteId);
    if (!site.bookingEnabled) {
      return { slots: [] };
    }

    const config = await this.configRepository.findOne({ where: { siteId } });
    if (!config) {
      throw new NotFoundException('Site booking configuration not found');
    }

    const { startBoundary, endBoundary, requestedDates } =
      this.resolveTimeBoundaries(
        startDate || format(new Date(), 'yyyy-MM-dd'),
        endDate || startDate || format(new Date(), 'yyyy-MM-dd'),
        config.bookingTimezone || 'UTC',
      );

    const rawResourceIds = resourceId
      ? resourceId
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      : [];

    const isSingleResource = rawResourceIds.length === 1;
    const isMultiResource = rawResourceIds.length > 1;
    const singleResourceId = isSingleResource ? rawResourceIds[0] : null;

    let allResources: BookingResource[] = [];
    if (!isSingleResource) {
      const siteResources = await this.resourceRepository.find({
        where: { siteId },
      });
      allResources = isMultiResource
        ? siteResources.filter((r) => rawResourceIds.includes(r.id))
        : siteResources;
    }

    const bookings = await this.fetchConfirmedBookings(
      siteId,
      startBoundary,
      endBoundary,
      rawResourceIds,
    );
    const blockouts = await this.fetchBlockouts(
      siteId,
      startBoundary,
      endBoundary,
      rawResourceIds,
    );
    const slotTimes = this.generateSlotTimeBlocks(
      config,
      startBoundary,
      endBoundary,
      requestedDates,
    );
    const redisMap = await this.getHoldStatusFromRedis(
      siteId,
      singleResourceId,
      allResources,
      slotTimes,
    );

    return this.evaluateSlotAvailability(
      siteId,
      singleResourceId,
      allResources,
      bookings,
      blockouts,
      slotTimes,
      redisMap,
    );
  }

  private async fetchBlockouts(
    siteId: string,
    startBoundary: Date,
    endBoundary: Date,
    resourceIds: string[] = [],
  ) {
    const query = this.blockoutRepository
      .createQueryBuilder('b')
      .where('b.siteId = :siteId', { siteId })
      .andWhere('b.endAt >= :startBoundary', { startBoundary })
      .andWhere('b.startAt <= :endBoundary', { endBoundary });

    if (resourceIds.length === 1) {
      query.andWhere('(b.resourceId IS NULL OR b.resourceId = :resourceId)', {
        resourceId: resourceIds[0],
      });
    } else if (resourceIds.length > 1) {
      query.andWhere(
        '(b.resourceId IS NULL OR b.resourceId IN (:...resourceIds))',
        {
          resourceIds,
        },
      );
    }

    return query.getMany();
  }

  private resolveTimeBoundaries(
    startDate: string,
    endDate: string,
    timezone: string,
  ) {
    const parseToDateStr = (str: string): string => {
      if (!str) return formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
      try {
        if (str.includes('T') || str.includes(':')) {
          const parsed = parseISO(str);
          if (!isNaN(parsed.getTime())) {
            return formatInTimeZone(parsed, timezone, 'yyyy-MM-dd');
          }
        }
        return str.trim().split('T')[0];
      } catch {
        return str.trim().split('T')[0];
      }
    };

    const startDates = startDate
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    const endDates = endDate
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    const rawDateStrs = [...startDates, ...endDates];
    const normalizedDates = Array.from(
      new Set(rawDateStrs.map((d) => parseToDateStr(d))),
    ).sort();

    const minDateStr =
      normalizedDates[0] ||
      formatInTimeZone(new Date(), timezone, 'yyyy-MM-dd');
    const maxDateStr =
      normalizedDates[normalizedDates.length - 1] || minDateStr;

    const minZonedStart = fromZonedTime(`${minDateStr}T00:00:00`, timezone);
    const maxZonedEnd = fromZonedTime(`${maxDateStr}T23:59:59.999`, timezone);

    const todayInSiteTimezone = formatInTimeZone(
      new Date(),
      timezone,
      'yyyy-MM-dd',
    );
    const startBoundary =
      minDateStr === todayInSiteTimezone ? new Date() : minZonedStart;
    const endBoundary = maxZonedEnd;

    return { startBoundary, endBoundary, requestedDates: normalizedDates };
  }

  private async fetchConfirmedBookings(
    siteId: string,
    startBoundary: Date,
    endBoundary: Date,
    resourceIds: string[] = [],
  ) {
    const bookingsQuery = this.bookingRepository
      .createQueryBuilder('booking')
      .where('booking.siteId = :siteId', { siteId })
      .andWhere('booking.status != :cancelled', {
        cancelled: BookingStatus.CANCELLED,
      })
      .andWhere('booking.endAt >= :startBoundary', { startBoundary })
      .andWhere('booking.startAt <= :endBoundary', { endBoundary });

    if (resourceIds.length === 1) {
      bookingsQuery.andWhere(
        'COALESCE("booking"."resourceId"::text, \'___NULL___\') = COALESCE(:resourceId::text, \'___NULL___\')',
        { resourceId: resourceIds[0] },
      );
    } else if (resourceIds.length > 1) {
      bookingsQuery.andWhere('booking.resourceId IN (:...resourceIds)', {
        resourceIds,
      });
    }

    return bookingsQuery.getMany();
  }

  private generateSlotTimeBlocks(
    config: SiteBookingConfig,
    startBoundary: Date,
    endBoundary: Date,
    requestedDates?: string[],
  ) {
    const timezone = config.bookingTimezone || 'UTC';
    const duration = config.bookingSlotDuration || 30;

    const slotTimes: {
      slotStart: Date;
      slotEnd: Date;
      dayEnd: Date;
      isPast: boolean;
    }[] = [];
    let currentDay = startOfDay(startBoundary);

    while (!isAfter(currentDay, endBoundary)) {
      const dayOfWeek = getDay(currentDay) === 0 ? 7 : getDay(currentDay);
      const dateStr = format(currentDay, 'yyyy-MM-dd');

      if (
        config.bookingAvailableDays.includes(dayOfWeek) &&
        (!requestedDates ||
          requestedDates.length === 0 ||
          requestedDates.includes(dateStr))
      ) {
        const dayStartTimeStr = `${dateStr}T${config.bookingStartTime}:00`;
        const dayEndTimeStr = `${dateStr}T${config.bookingEndTime}:00`;

        let slotStart = fromZonedTime(dayStartTimeStr, timezone);
        const dayEnd = fromZonedTime(dayEndTimeStr, timezone);
        let slotEnd = addMinutes(slotStart, duration);

        while (isBefore(slotStart, dayEnd) || isEqual(slotStart, dayEnd)) {
          const now = new Date();
          if (slotStart >= startBoundary && slotEnd <= endBoundary) {
            slotTimes.push({
              slotStart,
              slotEnd,
              dayEnd,
              isPast: slotStart < now,
            });
          }
          slotStart = slotEnd;
          slotEnd = addMinutes(slotStart, duration);
        }
      }
      currentDay = addMinutes(currentDay, 24 * 60);
    }
    return slotTimes;
  }

  private async getHoldStatusFromRedis(
    siteId: string,
    resourceId: string | null,
    allResources: BookingResource[],
    slotTimes: { slotStart: Date; slotEnd: Date; isPast: boolean }[],
  ): Promise<Map<string, boolean>> {
    const expectedKeys: string[] = [];
    if (resourceId) {
      for (const slot of slotTimes) {
        if (!slot.isPast) {
          expectedKeys.push(
            this.buildHoldKey(
              siteId,
              resourceId,
              slot.slotStart.toISOString(),
              slot.slotEnd.toISOString(),
            ),
          );
        }
      }
    } else {
      for (const slot of slotTimes) {
        if (!slot.isPast) {
          for (const resource of allResources) {
            expectedKeys.push(
              this.buildHoldKey(
                siteId,
                resource.id,
                slot.slotStart.toISOString(),
                slot.slotEnd.toISOString(),
              ),
            );
          }
        }
      }
    }

    const redisValues =
      expectedKeys.length > 0 ? await this.redis.mget(...expectedKeys) : [];
    const redisMap = new Map<string, boolean>();
    expectedKeys.forEach((key, idx) => {
      if (redisValues[idx]) redisMap.set(key, true);
    });

    return redisMap;
  }

  private evaluateSlotAvailability(
    siteId: string,
    resourceId: string | null,
    allResources: BookingResource[],
    bookings: Booking[],
    blockouts: BookingBlockout[],
    slotTimes: { slotStart: Date; slotEnd: Date; isPast: boolean }[],
    redisMap: Map<string, boolean>,
  ) {
    const availableSlots: SlotItem[] = [];

    for (const slot of slotTimes) {
      if (slot.isPast) continue;

      const slotStart = slot.slotStart;
      const slotEnd = slot.slotEnd;

      if (resourceId) {
        const isOverlapping = bookings.some((b) => {
          const bStart = new Date(b.startAt);
          const bEnd = new Date(b.endAt);
          return slotStart < bEnd && slotEnd > bStart;
        });

        const isBlocked = blockouts.some((bo) => {
          const boStart = new Date(bo.startAt);
          const boEnd = new Date(bo.endAt);
          const matchesResource =
            !bo.resourceId || bo.resourceId === resourceId;
          return matchesResource && slotStart < boEnd && slotEnd > boStart;
        });

        if (!isOverlapping && !isBlocked) {
          const key = this.buildHoldKey(
            siteId,
            resourceId,
            slotStart.toISOString(),
            slotEnd.toISOString(),
          );
          const isHolding = redisMap.has(key);

          availableSlots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            resourceId,
            status: isHolding ? 'HOLDING' : 'AVAILABLE',
          });
        }
      } else {
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
          if (isOverlapping) return false;

          const isBlocked = blockouts.some((bo) => {
            const boStart = new Date(bo.startAt);
            const boEnd = new Date(bo.endAt);
            const matchesResource =
              !bo.resourceId || bo.resourceId === resource.id;
            return matchesResource && slotStart < boEnd && slotEnd > boStart;
          });
          return !isBlocked;
        });

        if (freeResources.length > 0) {
          const unheldResources = freeResources.filter((resource) => {
            const key = this.buildHoldKey(
              siteId,
              resource.id,
              slotStart.toISOString(),
              slotEnd.toISOString(),
            );
            return !redisMap.has(key);
          });

          availableSlots.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            status: unheldResources.length > 0 ? 'AVAILABLE' : 'HOLDING',
            availableResources: unheldResources.map((r) => ({
              resourceId: r.id,
              resourceName: r.name,
            })),
          });
        }
      }
    }

    return { slots: availableSlots };
  }

  async holdSlot(siteId: string, dto: HoldSlotDto, emitEvent = true) {
    if (dto.slots && dto.slots.length > 0) {
      return this.holdSlots(siteId, dto.slots, dto.sessionId);
    }
    if (!dto.resourceId || !dto.startAt || !dto.endAt) {
      throw new BadRequestException(
        'resourceId, startAt, and endAt are required when slots array is not provided',
      );
    }

    const site = await this.siteService.findOneEntity(siteId);
    if (!site.bookingEnabled) {
      throw new BadRequestException('Booking is disabled for this site');
    }

    // Check if slot overlaps with any active blockout
    const overlappingBlockout = await this.blockoutRepository
      .createQueryBuilder('b')
      .where('b.siteId = :siteId', { siteId })
      .andWhere(
        'tstzrange("b"."startAt", "b"."endAt") && tstzrange(:startAt::timestamptz, :endAt::timestamptz)',
        {
          startAt: dto.startAt,
          endAt: dto.endAt,
        },
      )
      .andWhere('(b.resourceId IS NULL OR b.resourceId = :resourceId)', {
        resourceId: dto.resourceId,
      })
      .getOne();

    if (overlappingBlockout) {
      throw new ConflictException(
        overlappingBlockout.reason
          ? `Selected time is blocked: ${overlappingBlockout.reason}`
          : 'Selected time is blocked (holiday or staff leave)',
      );
    }

    const key = this.buildHoldKey(
      siteId,
      dto.resourceId,
      dto.startAt,
      dto.endAt,
    );

    // If slot is already held, check if it belongs to the same session
    const existing = await this.redis.get(key);
    if (existing) {
      try {
        const parsed = JSON.parse(existing) as { sessionId?: string };
        if (parsed.sessionId === dto.sessionId) {
          await this.redis.expire(key, 600);
          return { success: true };
        }
      } catch {
        // invalid json, proceed to overwrite/set
      }
      throw new ConflictException('Slot is currently being held');
    }

    const value = JSON.stringify({
      sessionId: dto.sessionId,
      createdAt: new Date().toISOString(),
    });

    const result = await this.redis.set(key, value, 'EX', 600, 'NX');

    if (result !== 'OK') {
      throw new ConflictException('Slot is currently being held');
    }

    if (emitEvent) {
      this.bookingGateway.emitSlotHeld(siteId, {
        resourceId: dto.resourceId,
        startAt: dto.startAt,
        endAt: dto.endAt,
      });
    }

    return { success: true };
  }

  async holdSlots(
    siteId: string,
    slots: Array<{
      resourceId: string;
      startAt: string;
      endAt: string;
      serviceId?: string;
    }>,
    sessionId: string,
  ): Promise<{ sessionId: string }> {
    // Validate duplicate slots in request
    const seenHoldKeys = new Set<string>();
    for (const s of slots) {
      const key = this.buildHoldKey(siteId, s.resourceId, s.startAt, s.endAt);
      if (seenHoldKeys.has(key)) {
        throw new BadRequestException(
          'Duplicate slots detected in hold request for the same resource and time.',
        );
      }
      seenHoldKeys.add(key);
    }

    const newKeys = slots.map((s) =>
      this.buildHoldKey(siteId, s.resourceId, s.startAt, s.endAt),
    );

    // Release any other slots previously held by this session
    await this.releaseSessionHolds(siteId, sessionId, newKeys);

    for (const slot of slots) {
      await this.holdSlot(
        siteId,
        {
          resourceId: slot.resourceId,
          serviceId: slot.serviceId,
          startAt: slot.startAt,
          endAt: slot.endAt,
          sessionId,
        },
        false,
      );
    }

    this.bookingGateway.emitSlotsHeld(
      siteId,
      slots.map((s) => ({
        resourceId: s.resourceId,
        startAt: s.startAt,
        endAt: s.endAt,
      })),
    );

    return { sessionId };
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const stream = this.redis.scanStream({ match: pattern, count: 100 });
      const foundKeys: string[] = [];
      stream.on('data', (resultKeys: string[]) => {
        foundKeys.push(...resultKeys);
      });
      stream.on('end', () => resolve(foundKeys));
      stream.on('error', (err) => reject(err));
    });
  }

  async getActiveHolds(siteId: string) {
    const pattern = `booking_hold:site:${siteId}:resource:*`;
    const keys = await this.scanKeys(pattern);

    return keys.map((key) => {
      // Key format: booking_hold:site:${siteId}:resource:${resourceId}:time:${startAt}_${endAt}
      // startAt and endAt contain colons, so we must extract by finding exact markers
      const timeIndex = key.indexOf(':time:');
      const timeString = key.substring(timeIndex + 6);
      const [startAt, endAt] = timeString.split('_');

      const resourceIndex = key.indexOf(':resource:');
      const resourceId = key.substring(resourceIndex + 10, timeIndex);

      return { resourceId, startAt, endAt, status: 'HOLDING' as const };
    });
  }

  async releaseHold(siteId: string, dto: HoldSlotDto) {
    if (dto.slots && dto.slots.length > 0) {
      for (const slot of dto.slots) {
        const key = this.buildHoldKey(
          siteId,
          slot.resourceId,
          slot.startAt,
          slot.endAt,
        );
        await this.redis.del(key);

        this.bookingGateway.emitSlotReleased(siteId, {
          resourceId: slot.resourceId,
          startAt: slot.startAt,
          endAt: slot.endAt,
        });
      }
      return { success: true };
    }

    if (dto.resourceId && dto.startAt && dto.endAt) {
      const key = this.buildHoldKey(
        siteId,
        dto.resourceId,
        dto.startAt,
        dto.endAt,
      );
      await this.redis.del(key);

      this.bookingGateway.emitSlotReleased(siteId, {
        resourceId: dto.resourceId,
        startAt: dto.startAt,
        endAt: dto.endAt,
      });

      return { success: true };
    }

    if (dto.sessionId) {
      await this.releaseSessionHolds(siteId, dto.sessionId);
      return { success: true };
    }

    return { success: true };
  }

  async releaseSessionHolds(
    siteId: string,
    sessionId: string,
    excludeKeys: string[] = [],
  ): Promise<void> {
    if (!sessionId) return;
    const pattern = `booking_hold:site:${siteId}:resource:*`;
    const keys = await this.scanKeys(pattern);

    for (const key of keys) {
      if (excludeKeys.includes(key)) continue;
      const val = await this.redis.get(key);
      if (val) {
        try {
          const parsed = JSON.parse(val) as { sessionId?: string };
          if (parsed.sessionId === sessionId) {
            const timeIndex = key.indexOf(':time:');
            const timeString = key.substring(timeIndex + 6);
            const [startAt, endAt] = timeString.split('_');
            const resourceIndex = key.indexOf(':resource:');
            const resourceId = key.substring(resourceIndex + 10, timeIndex);

            await this.releaseHold(siteId, {
              resourceId,
              startAt,
              endAt,
              sessionId,
            });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  async getHold(
    siteId: string,
    resourceId: string,
    startAt: string,
    endAt: string,
  ): Promise<{ sessionId: string } | null> {
    const holdKey = this.buildHoldKey(siteId, resourceId, startAt, endAt);
    const holdDataStr = await this.redis.get(holdKey);
    if (!holdDataStr) return null;
    try {
      return JSON.parse(holdDataStr) as { sessionId: string };
    } catch {
      return null;
    }
  }

  async createBooking(dto: CreateBookingDto): Promise<Booking> {
    const site = await this.siteService.findOneEntity(dto.siteId);
    if (!site.bookingEnabled) {
      throw new BadRequestException('Booking is disabled for this site');
    }

    const config = await this.getSiteBookingConfig(dto.siteId);
    const duration = config.bookingSlotDuration || 30;
    const isSalon = site.industryTemplateId === 'salon';

    // Multi-slot array mode
    if (dto.slots && dto.slots.length > 0) {
      // Validate no duplicate slots in the same request
      const seenSlots = new Set<string>();
      for (const slot of dto.slots) {
        const slotKey = `${slot.resourceId || 'default'}__${slot.date}__${slot.timeSlot}`;
        if (seenSlots.has(slotKey)) {
          throw new BadRequestException(
            `Duplicate slot detected for staff on date ${slot.date} at ${slot.timeSlot}. Each slot must have a unique time or staff.`,
          );
        }
        seenSlots.add(slotKey);
      }

      const groupedSpans = groupConsecutiveSlots(
        dto.slots,
        duration,
        config.bookingTimezone || 'UTC',
      );

      const totalSlots = dto.slots.length;
      const slotServiceIds = dto.slots.map((s) => s.serviceId).filter(Boolean);
      const providedServices =
        dto.serviceIds && dto.serviceIds.length > 0
          ? dto.serviceIds
          : slotServiceIds.length === totalSlots
            ? (slotServiceIds as string[])
            : dto.serviceId
              ? [dto.serviceId]
              : [];

      if (isSalon && totalSlots > 1) {
        if (providedServices.length !== totalSlots) {
          throw new BadRequestException(
            `Salon booking requires exactly 1 service per slot. You selected ${totalSlots} slots but ${providedServices.length} services.`,
          );
        }
      }

      const createdBookings: Booking[] = [];
      let serviceIndex = 0;

      for (const span of groupedSpans) {
        const spanServiceIds = isSalon
          ? span.serviceIds && span.serviceIds.length === span.slotCount
            ? span.serviceIds
            : providedServices.slice(
                serviceIndex,
                serviceIndex + span.slotCount,
              )
          : providedServices;
        serviceIndex += span.slotCount;

        const spanNotes = span.slotNotes.filter(Boolean);
        let spanNotesText: string | undefined = undefined;
        if (dto.notes && spanNotes.length > 0) {
          spanNotesText = `${dto.notes}\n${spanNotes.join('\n')}`;
        } else if (spanNotes.length > 0) {
          spanNotesText = spanNotes.join('\n');
        } else {
          spanNotesText = dto.notes;
        }

        const subDto: CreateBookingDto = {
          ...dto,
          notes: spanNotesText,
          slots: undefined,
          resourceId: span.resourceId,
          startAt: span.startAt,
          endAt: span.endAt,
          serviceId: spanServiceIds[0] ?? dto.serviceId,
          serviceIds: spanServiceIds.length ? spanServiceIds : undefined,
          templateFields: {
            ...dto.templateFields,
            serviceIds: spanServiceIds,
            slotCount: span.slotCount,
            startTimeSlot: span.startTimeSlot,
            endTimeSlot: span.endTimeSlot,
            slots: span.slots.map((s) => ({
              date: s.date,
              timeSlot: s.timeSlot,
              serviceId: s.serviceId,
              resourceId: s.resourceId,
              notes: s.notes || s.note,
            })),
          },
        };

        const singleBooking = await this.createSingleBooking(
          subDto,
          site,
          config,
        );
        createdBookings.push(singleBooking);
      }

      if (createdBookings.length > 1) {
        const allCodes = createdBookings.map((b) => b.code);
        createdBookings[0].templateFields = {
          ...createdBookings[0].templateFields,
          allBookingCodes: allCodes,
          totalBookingsCount: createdBookings.length,
        };
      }

      return createdBookings[0];
    }

    // Single booking mode
    return this.createSingleBooking(dto, site, config);
  }

  private async createSingleBooking(
    dto: CreateBookingDto,
    site: { id: string; name: string; industryTemplateId?: string },
    config?: SiteBookingConfig,
  ): Promise<Booking> {
    const bookingDate = new Date(dto.startAt);

    // Prevent booking for days before today
    if (isBefore(startOfDay(bookingDate), startOfDay(new Date()))) {
      throw new BadRequestException('Cannot create a booking for a past day');
    }

    const bookingConfig =
      config || (await this.getSiteBookingConfig(dto.siteId));
    const duration = bookingConfig.bookingSlotDuration || 30;
    const diffMins = Math.round(
      (parseISO(dto.endAt).getTime() - parseISO(dto.startAt).getTime()) / 60000,
    );
    const slotCount = Math.max(1, Math.round(diffMins / duration));

    const isSalon = site.industryTemplateId === 'salon';
    const providedServices =
      dto.serviceIds ?? (dto.serviceId ? [dto.serviceId] : []);

    if (isSalon && slotCount > 1) {
      if (providedServices.length !== slotCount) {
        throw new BadRequestException(
          `Salon booking requires exactly 1 service per slot. You selected ${slotCount} slots but ${providedServices.length} services.`,
        );
      }
    }

    // Check if slot overlaps with any active blockout
    const overlappingBlockout = await this.blockoutRepository
      .createQueryBuilder('b')
      .where('b.siteId = :siteId', { siteId: dto.siteId })
      .andWhere(
        'tstzrange("b"."startAt", "b"."endAt") && tstzrange(:startAt::timestamptz, :endAt::timestamptz)',
        {
          startAt: dto.startAt,
          endAt: dto.endAt,
        },
      )
      .andWhere('(b.resourceId IS NULL OR b.resourceId = :resourceId)', {
        resourceId: dto.resourceId || null,
      })
      .getOne();

    if (overlappingBlockout) {
      throw new ConflictException(
        overlappingBlockout.reason
          ? `Selected time is blocked: ${overlappingBlockout.reason}`
          : 'Selected time is blocked (holiday or staff leave)',
      );
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

    // Verify hold session across all sub-slots in the span
    if (dto.resourceId) {
      let subStart = parseISO(dto.startAt);
      for (let i = 0; i < slotCount; i++) {
        const subEnd = addMinutes(subStart, duration);
        const subKey = this.buildHoldKey(
          dto.siteId,
          dto.resourceId,
          subStart.toISOString(),
          subEnd.toISOString(),
        );
        const holdDataStr = await this.redis.get(subKey);
        if (holdDataStr) {
          const holdData = JSON.parse(holdDataStr) as { sessionId: string };
          if (dto.sessionId && holdData.sessionId !== dto.sessionId) {
            throw new BadRequestException('Hold belongs to another session.');
          }
        }
        subStart = subEnd;
      }
    }

    // Generate a code, for simplicity we can use a random short string
    const code = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Resolve all service names for providedServices
    const serviceNames: string[] = [];
    if (providedServices.length) {
      for (const sId of providedServices) {
        const s = await this.getServiceById(dto.siteId, sId);
        if (s) serviceNames.push(s.name);
      }
    }

    // Build slot-level breakdown if multiple slots
    let slotsBreakdown =
      (dto.templateFields?.slots as Array<Record<string, unknown>>) || [];
    if (!slotsBreakdown || slotsBreakdown.length === 0) {
      let subStart = parseISO(dto.startAt);
      slotsBreakdown = [];
      for (let i = 0; i < slotCount; i++) {
        const sId = providedServices[i] || providedServices[0];
        const sName = serviceNames[i] || serviceNames[0];
        const timeStr = formatInTimeZone(
          subStart,
          dto.timezone || 'UTC',
          'HH:mm',
        );
        slotsBreakdown.push({
          timeSlot: timeStr,
          serviceId: sId,
          serviceName: sName,
          resourceId: dto.resourceId,
        });
        subStart = addMinutes(subStart, duration);
      }
    } else {
      slotsBreakdown = slotsBreakdown.map((s, idx) => ({
        ...s,
        serviceName: s.serviceName || serviceNames[idx] || serviceNames[0],
      }));
    }

    // Deduplicate IDs for ManyToMany relation to respect primary key (bookingId, serviceId)
    const uniqueServiceIds = Array.from(new Set(providedServices));
    const assignedServices = uniqueServiceIds.map(
      (id) => ({ id }) as unknown as BookingServiceItem,
    );

    const booking = this.bookingRepository.create({
      ...dto,
      serviceId: providedServices[0] ?? dto.serviceId ?? null,
      services: assignedServices,
      templateFields: {
        ...dto.templateFields,
        serviceIds: providedServices,
        serviceNames,
        slots: slotsBreakdown,
        slotCount,
      },
      code,
      status: BookingStatus.CONFIRMED,
    });

    try {
      const savedBooking = await this.bookingRepository.save(booking);

      if (dto.resourceId) {
        // Clear all sub-slot hold keys for the span
        let curr = parseISO(dto.startAt);
        const end = parseISO(dto.endAt);
        while (isBefore(curr, end)) {
          const next = addMinutes(curr, duration);
          const subKey = this.buildHoldKey(
            dto.siteId,
            dto.resourceId,
            curr.toISOString(),
            next.toISOString(),
          );
          await this.redis.del(subKey);
          this.bookingGateway.emitSlotConfirmed(dto.siteId, {
            resourceId: dto.resourceId,
            startAt: curr.toISOString(),
            endAt: next.toISOString(),
          });
          curr = next;
        }
        const fullSpanKey = this.buildHoldKey(
          dto.siteId,
          dto.resourceId,
          dto.startAt,
          dto.endAt,
        );
        await this.redis.del(fullSpanKey);
      }

      if (savedBooking.customerEmail) {
        const serviceName = serviceNames.length
          ? serviceNames.join(', ')
          : 'N/A';
        const resource = dto.resourceId
          ? await this.getResourceById(dto.siteId, dto.resourceId)
          : null;

        void this.emailQueueService.enqueueBookingConfirmationEmail({
          to: savedBooking.customerEmail,
          customerName: savedBooking.customerName,
          bookingCode: savedBooking.code,
          serviceName,
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
      .leftJoinAndSelect('booking.services', 'services')
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
      .leftJoinAndSelect('booking.services', 'services')
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

  async bulkCancelBookings(
    siteId: string,
    bookingIds: string[],
  ): Promise<{ success: boolean; cancelledCount: number }> {
    let cancelledCount = 0;
    for (const bookingId of bookingIds) {
      try {
        await this.cancelBooking(siteId, bookingId);
        cancelledCount++;
      } catch (err) {
        this.logger.warn(
          `Failed to cancel booking ${bookingId} in bulk: ${(err as Error).message}`,
        );
      }
    }
    return { success: true, cancelledCount };
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

  // ── Blockout Management ──────────────────────────────────────────────────

  async getBlockouts(
    siteId: string,
    startDate?: string,
    endDate?: string,
    resourceId?: string,
  ): Promise<BookingBlockout[]> {
    const query = this.blockoutRepository
      .createQueryBuilder('b')
      .leftJoinAndSelect('b.resource', 'resource')
      .where('b.siteId = :siteId', { siteId });

    if (startDate) {
      query.andWhere('b.endAt >= :startDate', { startDate });
    }
    if (endDate) {
      query.andWhere('b.startAt <= :endDate', { endDate });
    }
    if (resourceId) {
      query.andWhere('(b.resourceId IS NULL OR b.resourceId = :resourceId)', {
        resourceId,
      });
    }

    query.orderBy('b.startAt', 'ASC');
    return query.getMany();
  }

  async createBlockout(
    siteId: string,
    dto: CreateBlockoutDto,
  ): Promise<BookingBlockout> {
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);

    if (isAfter(start, end) || isEqual(start, end)) {
      throw new BadRequestException('endAt must be after startAt');
    }

    if (dto.resourceId) {
      const resource = await this.getResourceById(siteId, dto.resourceId);
      if (!resource) {
        throw new NotFoundException(
          `Staff resource ${dto.resourceId} not found`,
        );
      }
    }

    const blockout = this.blockoutRepository.create({
      siteId,
      resourceId: dto.resourceId || null,
      startAt: start,
      endAt: end,
      reason: dto.reason?.trim() || null,
    });

    const saved = await this.blockoutRepository.save(blockout);
    return this.blockoutRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { resource: true },
    });
  }

  async deleteBlockout(siteId: string, blockoutId: string): Promise<void> {
    const blockout = await this.blockoutRepository.findOne({
      where: { id: blockoutId, siteId },
    });

    if (!blockout) {
      throw new NotFoundException(`Blockout with ID ${blockoutId} not found`);
    }

    await this.blockoutRepository.remove(blockout);
  }
}
