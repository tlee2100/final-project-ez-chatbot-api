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
