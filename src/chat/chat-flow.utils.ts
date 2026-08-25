export type MultimodalPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export const parseMultimodalContent = (
  text: string,
  wrapUserInput = false,
): string | MultimodalPart[] => {
  if (!text || typeof text !== 'string') return text;

  const imageRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  const matches = [...text.matchAll(imageRegex)];

  if (!matches.length) {
    return wrapUserInput ? `<user_input>\n${text}\n</user_input>` : text;
  }

  const parts: MultimodalPart[] = [];
  let lastIndex = 0;

  for (const match of matches) {
    const [fullMatch, url] = match;
    const matchIndex = match.index ?? 0;
    const beforeText = text.slice(lastIndex, matchIndex).trim();

    if (beforeText) {
      parts.push({
        type: 'text',
        text: wrapUserInput
          ? `<user_input>\n${beforeText}\n</user_input>`
          : beforeText,
      });
    }

    parts.push({ type: 'image_url', image_url: { url } });
    lastIndex = matchIndex + fullMatch.length;
  }

  const afterText = text.slice(lastIndex).trim();
  if (afterText) {
    parts.push({
      type: 'text',
      text: wrapUserInput
        ? `<user_input>\n${afterText}\n</user_input>`
        : afterText,
    });
  }

  return parts;
};

export type BookingSlotSelection = {
  date: string;
  timeSlot: string;
  endTimeSlot?: string;
  slotCount?: number;
  serviceIds?: string[];
  slots?: Array<{
    resourceId: string;
    date: string;
    timeSlot: string;
    serviceId?: string;
  }>;
  resourceId?: string;
  language?: string;
};

export const parseBookingSlotSelection = (
  text: string,
): BookingSlotSelection | null => {
  const json = text.match(/^\/select-booking-slot\s+(.+?)\s+::/i)?.[1];
  if (!json) return null;

  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (typeof value.date !== 'string' || typeof value.timeSlot !== 'string') {
      return null;
    }

    return {
      date: value.date,
      timeSlot: value.timeSlot,
      endTimeSlot:
        typeof value.endTimeSlot === 'string' ? value.endTimeSlot : undefined,
      slotCount:
        typeof value.slotCount === 'number' ? value.slotCount : undefined,
      serviceIds: Array.isArray(value.serviceIds)
        ? (value.serviceIds as string[])
        : undefined,
      slots: Array.isArray(value.slots)
        ? (value.slots as Array<{
            resourceId: string;
            date: string;
            timeSlot: string;
            serviceId?: string;
          }>)
        : undefined,
      resourceId:
        typeof value.resourceId === 'string' ? value.resourceId : undefined,
      language: typeof value.language === 'string' ? value.language : undefined,
    };
  } catch {
    return null;
  }
};

export const isBookingSlotSelection = (text: string) =>
  parseBookingSlotSelection(text) !== null;

export const isBookingAbandonment = (text: string) =>
  /^(?:never\s*mind|stop|quit|exit|thôi(?:\s+(?:nhé|đi))?|bỏ\s+đi|dừng|thoát)[\s!.]*$/i.test(
    text.trim(),
  ) ||
  /\b(?:stop|quit|exit)\s+(?:the\s+)?booking\b|\b(?:do not|don't|no longer)\s+want\s+to\s+book\b|(?:không muốn|không cần|dừng|ngừng|thoát).*(?:đặt(?:\s+lịch)?|book)/i.test(
    text,
  );

export const detectBookingTriggerLocale = (
  text: string,
  preferredLocale?: string | null,
): string | null => {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Vietnamese triggers
  if (
    /^(?:(?:hello|hi|hey|xin\s*ch[àa]o|ch[àa]o(?:\s*b[ạa]n)?|al[ôo]|good\s*(?:morning|afternoon|evening))\s*[,.!~]?\s*)?(?:(?:tôi|mình|em|anh|chị)?\s*(?:muốn|cần)?\s*)?(?:(?:đ[ặăa]t|dat)\s*(?:l[ịi]ch(?:\s*h[ẹe]n)?|h[ẹe]n|s[âa]n|ch[ỗo]|ph[òo]ng)|l[êe]n\s*l[ịi]ch(?:\s*h[ẹe]n)?|book\s*(?:l[ịi]ch|h[ẹe]n|s[âa]n|ch[ỗo]|ph[òo]ng)|đăng\s*k[ýy]\s*(?:đ[ặăa]t\s*)?l[ịi]ch|đ[ặăa]t)[\s!.]*$/i.test(
      trimmed,
    )
  ) {
    return 'vi';
  }

  // Japanese triggers
  if (
    /^(?:(?:こんにちは|こんばんは|おはようございます|hello|hi)\s*[,.!~]?\s*)?(?:予約(?:したい|する|をお願いします|を取りたい)?|予約)[\s!.]*$/i.test(
      trimmed,
    )
  ) {
    return 'ja';
  }

  // Ambiguous short triggers inherit preferredLocale if available
  if (/^(?:book|booking)$/i.test(trimmed)) {
    if (preferredLocale && preferredLocale !== 'und') {
      return preferredLocale;
    }
    return 'en';
  }

  // English triggers
  if (
    /^(?:(?:hello|hi|hey|good\s*(?:morning|afternoon|evening))\s*[,.!~]?\s*)?(?:(?:i\s*(?:want|would\s*like|need)\s*to\s*)?(?:book|schedule|make)(?:\s*(?:an?|my))?\s*(?:appointment|booking|slot)?|book\s*now|booking|book|appointment)[\s!.]*$/i.test(
      trimmed,
    )
  ) {
    return 'en';
  }

  return null;
};

export const isNaturalBookingTrigger = (
  text: string,
  preferredLocale?: string | null,
): boolean => detectBookingTriggerLocale(text, preferredLocale) !== null;

export const detectSmallTalkLocale = (
  text: string,
  preferredLocale?: string | null,
): string | null => {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // Vietnamese greetings, meta-questions, and courtesies
  if (
    /^(?:(?:xin\s*)?chào(?:\s*(?:bạn|shop|ad|admin|em|anh|chị))?|alo|hế\s*lô|hé\s*lô|halo|cảm\s*ơn(?:\s*(?:nhiều|bạn|shop|ad|nhé))?|tạm\s*biệt)[\s!.]*$/i.test(
      trimmed,
    ) ||
    /^(?:(?:cho|mình|tôi|em|anh|chị)?\s*(?:muốn|cần)?\s*(?:đặt|hỏi|tư\s*vấn|hỗ\s*trợ)(?:\s*(?:một|1|chút|xíu|giúp))?\s*(?:câu\s*hỏi|chút|xíu|không|với|được\s*không)?|(?:tôi|mình|em)?\s*có\s*(?:một|1)?\s*câu\s*hỏi|đặt\s*(?:một|1)?\s*câu\s*hỏi|cần\s*(?:tư\s*vấn|hỗ\s*trợ)|tư\s*vấn\s*(?:giúp|mình|tôi)|hỏi\s*(?:chút|xíu|tẹo)|cho\s*(?:mình|tôi|em|anh|chị)?\s*hỏi)[\s!.,?]*$/i.test(
      trimmed,
    )
  ) {
    return 'vi';
  }

  // Japanese greetings and meta-questions
  if (
    /^(?:こんにちは|おはよう(?:ございます)?|こんばんは|ハロー|はじめまして|ありがとう(?:ございます)?|さようなら|バイバイ)[\s!.]*$/i.test(
      trimmed,
    ) ||
    /^(?:質問(?:があります|してもいいですか|いいですか)?|聞きたいこと(?:があります|がある)?|教えてください)[\s!.,?]*$/i.test(
      trimmed,
    )
  ) {
    return 'ja';
  }

  // Ambiguous short greetings inherit preferredLocale if available
  if (/^(?:hi|hello|hey|thanks?|thank\s*you|bye|bye\s*bye)$/i.test(trimmed)) {
    if (preferredLocale && preferredLocale !== 'und') {
      return preferredLocale;
    }
    return 'en';
  }

  // English greetings and meta-questions
  if (
    /^(?:good\s*(?:morning|afternoon|evening|day)|greetings|thank\s*you\s*so\s*much|goodbye|see\s*you)[\s!.]*$/i.test(
      trimmed,
    ) ||
    /^(?:(?:can|may|could)\s*i\s*ask(?:\s*(?:a|one|you))?\s*(?:question|something)?|i\s*(?:have|got)\s*(?:a|one)?\s*question|i\s*(?:want|would\s*like|need)\s*to\s*ask(?:\s*(?:a|one))?\s*question|quick\s*question|need\s*help|can\s*you\s*help(?:\s*me)?)[\s!.,?]*$/i.test(
      trimmed,
    )
  ) {
    return 'en';
  }

  return null;
};

export const isSmallTalkTrigger = (
  text: string,
  preferredLocale?: string | null,
): boolean => detectSmallTalkLocale(text, preferredLocale) !== null;

export const isBookingFlowIntent = (intent: string | null | undefined) =>
  intent === 'book_appointment' ||
  intent === 'booking_slot_selected' ||
  intent === 'book_appointment_init' ||
  intent === 'structured_booking_step';

export const isCancelFlowIntent = (intent: string | null | undefined) =>
  intent === 'cancel_booking' || intent === 'abort_cancel_flow';

export const shouldContinueBookingFlow = (
  activeFlow: string | null | undefined,
  classifiedIntent: string,
  userText = '',
  siteContext?: {
    bookingServices?: { name: string }[];
    bookingResources?: { name: string }[];
  },
) => {
  if (activeFlow !== 'BOOKING') return false;
  if (classifiedIntent === 'small_talk') return true;
  if (classifiedIntent !== 'question') return false;

  const value = userText.trim().toLocaleLowerCase();
  return [
    ...(siteContext?.bookingServices ?? []),
    ...(siteContext?.bookingResources ?? []),
  ].some(({ name }) => name.trim().toLocaleLowerCase() === value);
};

export const enforceBookingChipScope = (
  text: string,
  intent: string | null | undefined,
) =>
  isBookingFlowIntent(intent) || isCancelFlowIntent(intent)
    ? text
    : text.replace(/\s*<chips>.*?<\/chips>/gis, '');

export const stripRenderedSlotTimes = (text: string): string =>
  text
    .split(/\r?\n/)
    .filter((line) => !/\b(?:[01]\d|2[0-3]):[0-5]\d\b/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const stripReasoningContent = (text: string): string => {
  const withoutBlocks = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
  const orphanClosingTag = withoutBlocks.toLowerCase().lastIndexOf('</think>');

  return orphanClosingTag === -1
    ? withoutBlocks.replace(/<think\b[^>]*>[\s\S]*$/gi, '')
    : withoutBlocks.slice(orphanClosingTag + '</think>'.length);
};

export type KnowledgeSearchStatus = 'idle' | 'success' | 'empty' | 'error';

export const parseKnowledgeSearchOutput = (
  content: unknown,
): { status: Exclude<KnowledgeSearchStatus, 'idle'>; chunks: unknown[] } => {
  try {
    const parsed: unknown =
      typeof content === 'string' ? (JSON.parse(content) as unknown) : content;
    const payload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (
      payload?.error ||
      (typeof payload?.result === 'string' && /\berror\b/i.test(payload.result))
    ) {
      return { status: 'error', chunks: [] };
    }

    const chunks = Array.isArray(parsed)
      ? parsed
      : Array.isArray(payload?.chunks)
        ? payload.chunks
        : Array.isArray(payload?.results)
          ? payload.results
          : Array.isArray(payload?.result)
            ? payload.result
            : [];
    return { status: chunks.length ? 'success' : 'empty', chunks };
  } catch {
    return { status: 'error', chunks: [] };
  }
};

export const extractRequestedTimeSlot = (text: string) => {
  const meridiemMatch = text.match(
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/i,
  );
  if (meridiemMatch) {
    let hour = Number(meridiemMatch[1]) % 12;
    if (meridiemMatch[3].toLowerCase() === 'pm') hour += 12;
    return `${String(hour).padStart(2, '0')}:${meridiemMatch[2] ?? '00'}`;
  }

  const timeMatch = text.match(/\b([01]?\d|2[0-3])(?::|h)([0-5]\d)\b/i);
  return timeMatch ? `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}` : null;
};

export const isTimeSlotAvailable = (
  payload: unknown,
  timeSlot: string,
): boolean | undefined => {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  const slots = Array.isArray(payload)
    ? payload
    : [record?.slots, record?.result, record?.output, record?.data].find(
        Array.isArray,
      );

  if (!slots) return undefined;
  return slots.some(
    (slot) =>
      !!slot &&
      typeof slot === 'object' &&
      (slot as Record<string, unknown>).timeSlot === timeSlot &&
      (slot as Record<string, unknown>).available !== false,
  );
};

export const bookAppointmentToolNames = (latestUserText: string) => {
  if (/^\/confirm-booking\b/i.test(latestUserText.trim())) {
    return ['createBooking'];
  }

  if (/^\/update-draft-booking\b/i.test(latestUserText.trim())) {
    return ['draftBooking'];
  }

  return [
    'getSiteConfig',
    'getAvailableSlots',
    'holdSlot',
    'releaseHold',
    'draftBooking',
  ];
};

export const bookingCodeText = (code: string) => `\n\n**${code}**`;

export const normalizePhoneNumber = (raw: string): string => {
  const cleaned = raw.replace(/[\s.\-()]/g, '');
  if (cleaned.startsWith('+84')) {
    return `0${cleaned.slice(3).replace(/^0+/, '')}`;
  }
  if (cleaned.startsWith('84') && cleaned.length === 11) {
    return `0${cleaned.slice(2)}`;
  }
  return cleaned;
};

export type BookingHoursConfig = {
  availableDays?: number[];
  startTime?: string;
  endTime?: string;
  timezone?: string | null;
  slotDuration?: number;
};

export type BookingSiteContext = {
  name?: string;
  bookingEnabled?: boolean;
  bookingServices?: { id?: string; name: string }[];
  bookingResources?: { id?: string; name: string }[];
  bookingHours?: BookingHoursConfig;
};

export type BookingVisitorContext = {
  name?: string;
  email?: string;
};
