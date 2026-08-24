import {
  isBookingSlotSelection,
  type BookingSiteContext,
  type BookingVisitorContext,
} from './chat-flow.utils';
import type { LLMMessage } from './interfaces/llm-request.interface';

export type BookingChipAction =
  | 'select_service'
  | 'select_resource'
  | 'select_date'
  | 'choose_date'
  | 'no_preference'
  | 'skip_email'
  | 'submit_text'
  | 'cancel_booking';

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
  'select_service',
  'select_resource',
  'select_date',
  'choose_date',
  'no_preference',
  'skip_email',
  'submit_text',
  'cancel_booking',
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
  'service' | 'resource' | 'date' | 'name' | 'email';

const bookingStepFromText = (text: string): BookingOptionStep | null => {
  const step = text
    .match(
      /<booking-step>\s*(service|resource|date|name|email)\s*<\/booking-step>/i,
    )?.[1]
    ?.toLowerCase();
  if (step) return step as BookingOptionStep;

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

  return null;
};

export const stripModelBookingDirectives = (text: string): string =>
  text
    .replace(/\s*<chips>.*?<\/chips>/gis, '')
    .replace(/\s*<booking-step>.*?<\/booking-step>/gis, '');

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
  const selectedOption = parseBookingOptionSelection(latestUserText);
  let step = selectedOption
    ? selectedOption.action === 'select_service'
      ? 'resource'
      : selectedOption.action === 'select_resource' ||
          selectedOption.action === 'no_preference'
        ? 'date'
        : null
    : (bookingStepFromText(text) ?? fallbackStep);

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
  if (step === 'service') {
    items = (siteContext?.bookingServices ?? []).map((service) => ({
      action: 'select_service',
      value: service.id ?? service.name,
      label: service.name,
    }));
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
  } else if (step === 'name' && visitorContext?.name) {
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
  }

  return items.length ? [{ type: 'chips', items }] : [];
};
