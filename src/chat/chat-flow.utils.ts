import { formatInTimeZone } from 'date-fns-tz';

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

    parts.push({
      type: 'image_url',
      image_url: { url },
    });

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
  resourceId?: string;
  language?: 'en' | 'vi';
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
      resourceId:
        typeof value.resourceId === 'string' ? value.resourceId : undefined,
      language:
        value.language === 'en' || value.language === 'vi'
          ? value.language
          : undefined,
    };
  } catch {
    return null;
  }
};

export const isBookingSlotSelection = (text: string) =>
  !!parseBookingSlotSelection(text) ||
  /^(?:I choose|Tôi chọn)\s+\d{1,2}:\d{2}\b/i.test(text.trim());

export const replacePseudoToolResponse = (text: string, vietnamese: boolean) =>
  /^<(?:getSiteConfig|getAvailableSlots|createBooking|cancelBooking|getConversationContext|searchKnowledge)>$/i.test(
    text.trim(),
  )
    ? vietnamese
      ? 'Xin chào! Tôi có thể giúp gì cho bạn?'
      : 'Hi! How can I help you today?'
    : text;

export const cleanMixedLanguageResponse = (
  text: string,
  isVietnamese: boolean,
): string => {
  if (!isVietnamese) return text;
  // If the message is primarily Vietnamese, remove accidental leading English boilerplate sentences
  return text
    .replace(
      /^(?:(?:Great|Sure|Awesome|Alright|Okay|Got it)!\s*(?:Let'?s\s+(?:book|schedule|get)[^\n.!?]*[.!?])?\s*)+/i,
      '',
    )
    .trim();
};

export const isValidPhoneNumber = (raw: string): boolean => {
  if (!raw || typeof raw !== 'string') return false;
  const cleaned = raw.replace(/[\s.\-()]/g, '');
  // 1. Vietnam format: 10 digits starting with 03, 05, 07, 08, 09 or +84/84 followed by 9 digits
  const isVn = /^(?:\+84|84|0)(?:3|5|7|8|9)\d{8}$/.test(cleaned);
  // 2. International format (E.164): starts with + and 8-15 digits
  const isIntl = /^\+[1-9]\d{7,14}$/.test(cleaned);

  return isVn || isIntl;
};

export const normalizePhoneNumber = (raw: string): string => {
  if (!raw || typeof raw !== 'string') return raw;
  const cleaned = raw.replace(/[\s.\-()]/g, '');

  // If it's a Vietnam number (+84 or 84), normalize to 0...
  if (cleaned.startsWith('+84')) {
    return '0' + cleaned.slice(3).replace(/^0+/, '');
  }
  if (cleaned.startsWith('84') && cleaned.length === 11) {
    return '0' + cleaned.slice(2);
  }
  if (/^0[35789]\d{8}$/.test(cleaned)) {
    return cleaned;
  }

  return cleaned;
};

export const isVietnameseText = (text: string) =>
  /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]|\b(bạn|tôi|mình|không|ưu tiên|ngày|giờ|dịch vụ|đặt lịch|hủy lịch|nhân viên|thợ|vui lòng|chọn|thời gian|phù hợp|cảm ơn|chào|chào bạn|xin chào)\b/i.test(
    text,
  );

export const isEnglishText = (text: string) =>
  /\b(book|booking|appointment|schedule|service|staff|stylist|time|date|hello|hi|hey|thanks|thank you|yes|no|cancel|edit|change|name|phone|email|skip|please|which|what|prefer)\b/i.test(
    text,
  );

export const detectConversationLanguage = (
  messages: { role?: string; content: string }[],
  siteContext?: {
    bookingServices?: { name: string }[];
    bookingResources?: { name: string }[];
  },
): 'vi' | 'en' => {
  const entityNames = [
    ...(siteContext?.bookingServices?.map((s) => s.name.trim().toLowerCase()) ??
      []),
    ...(siteContext?.bookingResources?.map((r) =>
      r.name.trim().toLowerCase(),
    ) ?? []),
  ].filter(Boolean);

  // Scan user messages from most recent to oldest
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' && msg.role !== 'human') continue;
    const content = msg.content.trim();
    const lower = content.toLowerCase();

    // Ignore exact entity clicks (services, staff) or chip selections
    if (entityNames.includes(lower)) continue;
    if (/^\/select-booking-slot\b/i.test(content)) {
      if (content.includes('"language":"vi"')) return 'vi';
      if (content.includes('"language":"en"')) return 'en';
      continue;
    }
    if (/^(hôm nay|thứ|ngày khác|chọn ngày khác)/i.test(lower)) return 'vi';
    if (
      /^(today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|other date|choose another date)/i.test(
        lower,
      )
    )
      return 'en';
    if (/^(bỏ qua|không ưu tiên)/i.test(lower)) return 'vi';
    if (/^(skip|no preference)/i.test(lower)) return 'en';

    // Check natural language text in user's message
    if (isVietnameseText(content)) return 'vi';
    if (isEnglishText(content)) return 'en';
  }

  // If no clear user message yet, check assistant messages from oldest (greeting)
  for (const msg of messages) {
    const content = msg.content.trim();
    if (isVietnameseText(content)) return 'vi';
    if (isEnglishText(content)) return 'en';
  }

  return 'vi';
};

export type BookingHoursConfig = {
  availableDays?: number[];
  startTime?: string;
  endTime?: string;
  timezone?: string | null;
  slotDuration?: number;
};

export const generateDateChips = (
  bookingHours?: BookingHoursConfig,
  isVietnamese = true,
  baseNow = new Date(),
): string[] => {
  const timezone = bookingHours?.timezone || 'Asia/Ho_Chi_Minh';
  const availableDays = bookingHours?.availableDays?.length
    ? bookingHours.availableDays
    : [1, 2, 3, 4, 5, 6, 7];

  let localDateStr = '2026-08-16';
  let localTimeStr = '12:00';
  try {
    localDateStr = formatInTimeZone(baseNow, timezone, 'yyyy-MM-dd');
    localTimeStr = formatInTimeZone(baseNow, timezone, 'HH:mm');
  } catch {
    const d = new Date(baseNow);
    localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    localTimeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  const [year, month, day] = localDateStr.split('-').map(Number);
  const [currentHour, currentMin] = localTimeStr.split(':').map(Number);
  const currentMinutes = currentHour * 60 + currentMin;

  let endMinutes = 24 * 60;
  if (bookingHours?.endTime) {
    const [eh, em] = bookingHours.endTime.split(':').map(Number);
    if (!isNaN(eh) && !isNaN(em)) endMinutes = eh * 60 + em;
  }

  const chips: string[] = [];
  const vietnameseDays = [
    'Chủ nhật',
    'Thứ Hai',
    'Thứ Ba',
    'Thứ Tư',
    'Thứ Năm',
    'Thứ Sáu',
    'Thứ Bảy',
  ];
  const englishDays = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  const checkDate = new Date(year, month - 1, day);

  // Check today
  const todayDayOfWeek = checkDate.getDay(); // 0 = Sunday, 1 = Monday...
  const todayIsoWeekday = todayDayOfWeek === 0 ? 7 : todayDayOfWeek;

  if (availableDays.includes(todayIsoWeekday) && currentMinutes < endMinutes) {
    const dayStr = String(checkDate.getDate()).padStart(2, '0');
    const monthStr = String(checkDate.getMonth() + 1).padStart(2, '0');
    chips.push(
      isVietnamese
        ? `Hôm nay (${dayStr}/${monthStr})`
        : `Today (${dayStr}/${monthStr})`,
    );
  }

  // Next days until 5 date chips
  for (let i = 1; i <= 30 && chips.length < 5; i++) {
    const nextDate = new Date(year, month - 1, day + i);
    const dayOfWeek = nextDate.getDay();
    const isoWeekday = dayOfWeek === 0 ? 7 : dayOfWeek;

    if (availableDays.includes(isoWeekday)) {
      const dayStr = String(nextDate.getDate()).padStart(2, '0');
      const monthStr = String(nextDate.getMonth() + 1).padStart(2, '0');
      const dayName = isVietnamese
        ? vietnameseDays[dayOfWeek]
        : englishDays[dayOfWeek];
      chips.push(`${dayName} (${dayStr}/${monthStr})`);
    }
  }

  const pickAnother = isVietnamese ? 'Chọn ngày khác' : 'Choose another date';
  chips.push(pickAnother);

  return chips;
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

export const sanitizeBookingChips = (
  text: string,
  siteContext?: BookingSiteContext,
  visitorContext?: BookingVisitorContext,
  language?: 'vi' | 'en',
) => {
  if (siteContext?.bookingEnabled !== true) {
    return text;
  }

  const isVietnamese = language ? language === 'vi' : isVietnameseText(text);
  const noPreference = isVietnamese ? 'Không ưu tiên' : 'No Preference';
  const skipLabel = isVietnamese ? 'Bỏ qua' : 'Skip';
  const services =
    siteContext.bookingServices?.map((service) => service.name) ?? [];
  const resources =
    siteContext.bookingResources?.map((resource) => resource.name) ?? [];

  // Extract text without chips to analyze the current prompt/question being asked
  const textWithoutChips = text
    .replace(/\s*<chips>.*?<*\/?chips>/gis, '')
    .trim();
  const lines = textWithoutChips
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines[lines.length - 1] || textWithoutChips;
  // Separate into sentences if punctuation exists
  const sentences = lastLine.split(/(?<=[.?!:])\s+/).filter(Boolean);
  const lastSentence = (
    sentences[sentences.length - 1] || lastLine
  ).toLowerCase();

  // 1. Email step
  if (
    /(?:confirmation email|nhận email|gửi email|qua email|email)/i.test(
      lastSentence,
    )
  ) {
    const cleanedText = textWithoutChips
      .replace(
        /^(?:and your phone number\??|số điện thoại của bạn\??|vui lòng cho biết số điện thoại\??)[\s,.]*/i,
        '',
      )
      .trim();
    const formattedText = cleanedText
      ? cleanedText.charAt(0).toUpperCase() + cleanedText.slice(1)
      : textWithoutChips;
    const emailChips = visitorContext?.email
      ? [visitorContext.email, skipLabel]
      : [skipLabel];
    return `${formattedText}\n\n<chips>${emailChips.join('|')}</chips>`;
  }

  // 2. Name step
  if (
    /(?:what'?s your name|may i have your name|tên của bạn|bạn tên là gì|cho biết tên|tên bạn|tên của mình)/i.test(
      lastSentence,
    )
  ) {
    if (visitorContext?.name) {
      return `${textWithoutChips}\n\n<chips>${visitorContext.name}</chips>`;
    }
    return textWithoutChips;
  }

  // 3. Phone / Slot picker / Confirmation / Review card -> NO CHIPS
  if (
    /(?:your phone number|phone number|số điện thoại|sđt|khung giờ|chọn giờ|chọn khung giờ|select.*time|available time|review.*card|xem lại thông tin|xác nhận đặt lịch|kiểm tra lại)/i.test(
      lastSentence,
    )
  ) {
    return textWithoutChips;
  }

  // 3. Date step
  if (
    /(?:what date|which date|bạn muốn.*ngày|ngày nào|vào ngày nào|đặt lịch vào ngày|chọn ngày)/i.test(
      lastSentence,
    )
  ) {
    const dateChips = generateDateChips(siteContext.bookingHours, isVietnamese);
    return `${textWithoutChips}\n\n<chips>${dateChips.join('|')}</chips>`;
  }

  // 4. Staff / Stylist step
  if (/(?:preferred stylist|stylist|staff|nhân viên|thợ)/i.test(lastSentence)) {
    const options = [...resources, noPreference].filter(Boolean);
    return options.length
      ? `${textWithoutChips}\n\n<chips>${options.join('|')}</chips>`
      : textWithoutChips;
  }

  // 5. Service step
  if (
    /(?:which service|dịch vụ nào|chọn dịch vụ|muốn làm dịch vụ|service)/i.test(
      lastSentence,
    )
  ) {
    return services.length
      ? `${textWithoutChips}\n\n<chips>${services.join('|')}</chips>`
      : textWithoutChips;
  }

  // Fallback: If no recognized question pattern, sanitize based on context
  return text;
};

type SmallTalkSiteContext = {
  name?: string;
  bookingServices?: { name: string }[];
  bookingResources?: { name: string }[];
};

export const sanitizeSmallTalkResponse = (
  text: string,
  vietnamese: boolean,
  siteContext?: SmallTalkSiteContext,
) => {
  const bookingNames = [
    ...(siteContext?.bookingServices ?? []),
    ...(siteContext?.bookingResources ?? []),
  ]
    .map((item) => item.name.trim().toLowerCase())
    .filter(Boolean);
  const normalizedText = text.toLowerCase();
  const exposesBookingData =
    /<chips>.*?<\/chips>/i.test(text) ||
    bookingNames.some((name) => normalizedText.includes(name));

  if (!exposesBookingData) return text;

  const siteName = siteContext?.name?.trim();
  if (vietnamese) {
    return siteName
      ? `Xin chào! Chào mừng bạn đến với ${siteName}. Tôi có thể giúp gì cho bạn?`
      : 'Xin chào! Tôi có thể giúp gì cho bạn?';
  }
  return siteName
    ? `Hello! Welcome to ${siteName}. How can I assist you today?`
    : 'Hello! How can I assist you today?';
};
