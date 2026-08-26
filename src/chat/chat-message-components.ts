import {
  isBookingSlotSelection,
  type BookingSiteContext,
  type BookingVisitorContext,
} from './chat-flow.utils';
import type { LLMMessage } from './interfaces/llm-request.interface';

export type BookingChipAction =
  | 'select_booking_type'
  | 'select_party_size'
  | 'select_service'
  | 'skip_service'
  | 'select_resource'
  | 'select_date'
  | 'choose_date'
  | 'no_preference'
  | 'skip_email'
  | 'submit_text'
  | 'assign_remaining_service'
  | 'assign_slot_services'
  | 'cancel_booking'
  | 'keep_booking';

export type BookingChipItem = {
  action: BookingChipAction;
  value?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
};

export type ChatMessageComponent = {
  type: 'chips';
  items: BookingChipItem[];
};

export type BookingOptionSelection = {
  action: BookingChipAction;
  value?: string;
  label?: string;
  locale?: string;
};

const bookingChipActions = new Set<BookingChipAction>([
  'select_booking_type',
  'select_party_size',
  'select_service',
  'skip_service',
  'select_resource',
  'select_date',
  'choose_date',
  'no_preference',
  'skip_email',
  'submit_text',
  'assign_remaining_service',
  'assign_slot_services',
  'cancel_booking',
  'keep_booking',
]);

export const parseBookingOptionSelection = (
  text: string,
): BookingOptionSelection | null => {
  const json = text.match(/^\/select-booking-option\s+(.+?)\s+::/i)?.[1];
  if (!json) return null;

  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof value.action !== 'string' ||
      !bookingChipActions.has(value.action as BookingChipAction)
    ) {
      return null;
    }

    return {
      action: value.action as BookingChipAction,
      value: typeof value.value === 'string' ? value.value : undefined,
      label: typeof value.label === 'string' ? value.label : undefined,
      locale: typeof value.locale === 'string' ? value.locale : undefined,
    };
  } catch {
    return null;
  }
};

export const isBookingOptionSelection = (text: string): boolean =>
  parseBookingOptionSelection(text) !== null;

export const bookingOptionNeedsModel = (
  selection: BookingOptionSelection,
): boolean => Boolean(selection && false);

export const extractBookingCommandJson = (
  text: string,
  command: 'update-draft-booking' | 'confirm-booking',
): string | null => {
  const body = text.match(new RegExp(`^/${command}\\s+(.+)$`, 'i'))?.[1];
  if (!body) return null;

  const separatorIndex = body.lastIndexOf(' :: ');
  return separatorIndex === -1 ? body : body.slice(0, separatorIndex);
};

export const hasActiveStructuredBookingProgress = (
  messages: LLMMessage[],
  activeFlow?: string | null,
): boolean =>
  activeFlow === 'BOOKING' &&
  messages.some(
    (message) =>
      message.role === 'user' &&
      (isBookingOptionSelection(message.content) ||
        isBookingSlotSelection(message.content)),
  );

export type BookingOptionStep =
  | 'booking_type'
  | 'party_size'
  | 'service'
  | 'resource'
  | 'date'
  | 'name'
  | 'email'
  | 'assign_remaining_service'
  | 'assign_slot_services';

const bookingStepFromText = (text: string): BookingOptionStep | null => {
  const stepMatch = text
    .match(
      /<booking-step>\s*(booking_type|type|party_size|group_size|party|size|service(?:id)?|resource(?:id)?|staff|date|time(?:slot)?|name|customername|email|customeremail|assign_slot_services|assign_remaining_service|remaining|schedule)\s*<\/booking-step>/i,
    )?.[1]
    ?.toLowerCase();

  if (stepMatch) {
    if (
      stepMatch.includes('party') ||
      stepMatch.includes('group_size') ||
      stepMatch === 'size'
    )
      return 'party_size';
    if (stepMatch.includes('type')) return 'booking_type';
    if (stepMatch.includes('slot_services') || stepMatch.includes('schedule'))
      return 'assign_slot_services';
    if (stepMatch.startsWith('service')) return 'service';
    if (stepMatch.startsWith('resource') || stepMatch === 'staff')
      return 'resource';
    if (stepMatch === 'date') return 'date';
    if (stepMatch.includes('name')) return 'name';
    if (stepMatch.includes('email')) return 'email';
    if (stepMatch.includes('remaining') || stepMatch.includes('assign'))
      return 'assign_slot_services';
  }

  if (
    /<chips>.*?@.*?\..*?\|.*?(bỏ qua|skip|スキップ).*?<\/chips>/i.test(text) ||
    (/<chips>.*?(bỏ qua|skip|スキップ).*?<\/chips>/i.test(text) &&
      /(email|xác nhận|thư điện tử|メール)/i.test(text)) ||
    /(?:nhận\s*email|email\s*xác\s*nhận|cung\s*cấp\s*email|địa\s*chỉ\s*email|confirmation\s*email|receive\s*(?:a\s*)?(?:confirmation\s*)?email|provide\s*(?:your\s*)?email|email\s*address|メール)/i.test(
      text,
    )
  ) {
    return 'email';
  }

  const lower = text.toLowerCase();
  if (
    /(?:bao\s*nhiêu\s*người|số\s*lượng\s*người|how\s*many\s*people|party\s*size|group\s*size|何名)/i.test(
      lower,
    )
  ) {
    return 'party_size';
  }

  if (
    /(?:1\s*chỗ|nhiều\s*chỗ|1\s*slot|nhiều\s*slot|1\s*người|nhiều\s*người|đặt\s*1|đặt\s*nhiều)/i.test(
      lower,
    )
  ) {
    return 'booking_type';
  }

  if (
    /(?:không\s*đủ\s*cho\s*nhóm|chọn\s*khung\s*giờ\s*khác|not\s*enough\s*staff|another\s*time\s*slot)/i.test(
      lower,
    )
  ) {
    return null;
  }

  if (
    /(?:nhân\s*viên|chuyên\s*viên|thợ|bác\s*sĩ|huấn\s*luyện\s*viên|người\s*phục\s*vụ|stylist|barber|therapist|staff|specialist|resource|trainer)/i.test(
      lower,
    ) ||
    /(?:which|who|select|choose|preferred)\s*(?:staff|specialist|therapist|doctor|trainer|resource|barber|stylist|person)/i.test(
      lower,
    )
  ) {
    return 'resource';
  }

  if (
    /(?:chọn|vào|đặt)?\s*ngày\s*(?:nào|mấy|khác)?/i.test(lower) ||
    /(?:which|what|select|choose)\s*date/i.test(lower)
  ) {
    return 'date';
  }

  if (
    /(?:đặt|chọn|muốn)?\s*dịch\s*vụ\s*(?:nào|gì)?/i.test(lower) ||
    /(?:which|what|select|choose)\s*service/i.test(lower)
  ) {
    return 'service';
  }

  return null;
};

export const stripModelBookingDirectives = (text: string): string =>
  text
    .replace(/\s*<chips>.*?<\/chips>/gis, '')
    .replace(/\s*<booking-step>.*?<\/booking-step>/gis, '')
    .replace(/\s*<booking-input>.*?<\/booking-input>/gis, '');

const dateInTimezone = (date: Date, timezone: string): Date => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});

  return new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
  );
};

const dateChip = (value: string, baseNow: Date): BookingChipItem => {
  const selected = new Date(`${value}T00:00:00.000Z`);
  const today = new Date(
    Date.UTC(
      baseNow.getUTCFullYear(),
      baseNow.getUTCMonth(),
      baseNow.getUTCDate(),
    ),
  );
  const dayOffset = Math.round(
    (selected.getTime() - today.getTime()) / 86_400_000,
  );
  const date = `${value.slice(8, 10)}/${value.slice(5, 7)}`;

  return {
    action: 'select_date',
    value,
    labelKey:
      dayOffset === 0
        ? 'chip.today'
        : dayOffset === 1
          ? 'chip.tomorrow'
          : 'chip.date',
    labelParams: { date },
  };
};

const bookingDateItems = (
  siteContext: BookingSiteContext | undefined,
  baseNow: Date,
): BookingChipItem[] => {
  const localToday = dateInTimezone(
    baseNow,
    siteContext?.bookingHours?.timezone || 'UTC',
  );
  const configuredDays = (
    siteContext?.bookingHours?.availableDays ?? []
  ).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  const availableDays = new Set(
    configuredDays.length ? configuredDays : [1, 2, 3, 4, 5, 6, 7],
  );
  const items: BookingChipItem[] = [];

  for (let offset = 0; items.length < 5 && offset < 42; offset += 1) {
    const date = new Date(localToday);
    date.setUTCDate(localToday.getUTCDate() + offset);
    const bookingDay = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    if (!availableDays.has(bookingDay)) continue;

    items.push(dateChip(date.toISOString().slice(0, 10), localToday));
  }

  items.push({
    action: 'choose_date',
    labelKey: 'chip.chooseAnotherDate',
  });
  return items;
};

export const buildChatMessageComponents = (
  text: string,
  siteContext?: BookingSiteContext,
  visitorContext?: BookingVisitorContext,
  baseNow = new Date(),
  latestUserText = '',
  fallbackStep: BookingOptionStep | null = null,
): ChatMessageComponent[] => {
  const explicitChipsMatch = text.match(/<chips>(.*?)<\/chips>/is);
  if (explicitChipsMatch?.[1]) {
    const rawChips = explicitChipsMatch[1]
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    const keepBookingChips = rawChips.filter((chip) =>
      chip.startsWith('/keep-booking:'),
    );
    if (keepBookingChips.length > 0) {
      const explicitItems: BookingChipItem[] = keepBookingChips.map((chip) => ({
        action: 'keep_booking',
        value: '/keep-booking',
        label: chip.replace('/keep-booking:', '').trim(),
      }));
      return [{ type: 'chips', items: explicitItems }];
    }
  }

  const isSalon = siteContext?.industryTemplateId === 'salon';
  const explicitStep = bookingStepFromText(text);
  const selectedOption = parseBookingOptionSelection(latestUserText);

  let step: BookingOptionStep | null = explicitStep;
  if (!step && selectedOption) {
    if (selectedOption.action === 'select_booking_type') {
      if (isSalon && selectedOption.value === 'multiple') {
        step = 'party_size';
      } else if ((siteContext?.bookingServices ?? []).length > 0) {
        step = 'service';
      } else if ((siteContext?.bookingResources ?? []).length > 0) {
        step = 'resource';
      } else {
        step = 'date';
      }
    } else if (
      selectedOption.action === 'select_party_size' ||
      /^\d+$/.test(latestUserText.trim())
    ) {
      step =
        (siteContext?.bookingServices ?? []).length > 0 ? 'service' : 'date';
    } else if (
      selectedOption.action === 'select_service' ||
      selectedOption.action === 'skip_service'
    ) {
      step =
        (siteContext?.bookingResources ?? []).length > 0 ? 'resource' : 'date';
    } else if (
      selectedOption.action === 'select_resource' ||
      selectedOption.action === 'no_preference'
    ) {
      step = 'date';
    }
  }

  if (!step) {
    step = fallbackStep;
  }

  // Auto-fallback if step is service but site has no services configured
  if (step === 'service' && (siteContext?.bookingServices ?? []).length === 0) {
    step =
      (siteContext?.bookingResources ?? []).length > 0 ? 'resource' : 'date';
  }

  // Fallback to email step after phone submission if model omitted tags
  if (
    !step &&
    /^[+0-9\s().-]{7,25}$/.test(latestUserText.trim()) &&
    !latestUserText.trim().startsWith('/')
  ) {
    step = 'email';
  }

  let items: BookingChipItem[] = [];
  if (step === 'booking_type') {
    items = isSalon
      ? [
          {
            action: 'select_booking_type',
            value: 'single',
            labelKey: 'chip.singlePerson',
            label: 'Đặt cho 1 người',
          },
          {
            action: 'select_booking_type',
            value: 'multiple',
            labelKey: 'chip.groupBooking',
            label: 'Đặt cho nhiều người',
          },
        ]
      : [
          {
            action: 'select_booking_type',
            value: 'single',
            labelKey: 'chip.singleSlot',
            label: 'Đặt 1 chỗ',
          },
          {
            action: 'select_booking_type',
            value: 'multiple',
            labelKey: 'chip.multipleSlots',
            label: 'Đặt nhiều chỗ',
          },
        ];
  } else if (step === 'party_size') {
    items = [
      { action: 'select_party_size', value: '2', label: '2 người' },
      { action: 'select_party_size', value: '3', label: '3 người' },
      { action: 'select_party_size', value: '4', label: '4 người' },
      { action: 'select_party_size', value: '5', label: '5 người' },
      { action: 'select_party_size', value: '6', label: '6 người' },
    ];
  } else if (step === 'service') {
    items = (siteContext?.bookingServices ?? []).map((service) => ({
      action: 'select_service',
      value: service.id ?? service.name,
      label: service.name,
    }));
    const isGeneral =
      siteContext?.industryTemplateId === 'general' ||
      (siteContext?.industryTemplateId !== undefined &&
        siteContext?.industryTemplateId !== 'salon');
    if (isGeneral && items.length > 0) {
      items.push({
        action: 'skip_service',
        labelKey: 'chip.noService',
        label: 'Không chọn dịch vụ',
      });
    }
  } else if (step === 'resource') {
    items = [
      ...(siteContext?.bookingResources ?? []).map((resource) => ({
        action: 'select_resource' as const,
        value: resource.id ?? resource.name,
        label: resource.name,
      })),
      { action: 'no_preference', labelKey: 'chip.noPreference' },
    ];
  } else if (step === 'date') {
    items = bookingDateItems(siteContext, baseNow);
  } else if (
    step === 'name' &&
    visitorContext?.name &&
    visitorContext.name.trim().toLowerCase() !== 'guest' &&
    visitorContext.name.trim().toLowerCase() !== '[none]'
  ) {
    items = [
      {
        action: 'submit_text',
        value: visitorContext.name,
        label: visitorContext.name,
      },
    ];
  } else if (step === 'email') {
    items = [
      ...(visitorContext?.email
        ? [
            {
              action: 'submit_text' as const,
              value: visitorContext.email,
              label: visitorContext.email,
            },
          ]
        : []),
      { action: 'skip_email', labelKey: 'chip.skip' },
    ];
  } else if (step === 'assign_remaining_service') {
    items = (siteContext?.bookingServices ?? []).map((service) => ({
      action: 'assign_remaining_service' as const,
      value: service.id ?? service.name,
      label: service.name,
    }));
  }

  return items.length ? [{ type: 'chips', items }] : [];
};
