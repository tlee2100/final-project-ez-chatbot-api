export const extractBookingCode = (text: string): string | undefined =>
  text.match(/^\/(?:confirm-)?cancel-booking\s+(\S+)/i)?.[1] ??
  text.match(/\b(?:code|mã)\s*[:#-]?\s*([a-z0-9]{8})\b/i)?.[1] ??
  text.match(/\b[A-Z0-9]{8}\b/)?.[0];

export const latestActiveBookingCode = (
  content: string,
): string | undefined => {
  const cancelledCodes = new Set(
    Array.from(
      content.matchAll(/<booking-cancelled>(.*?)<\/booking-cancelled>/g),
      (match) => match[1],
    ),
  );
  return Array.from(
    content.matchAll(
      /<booking-code>(.*?)<\/booking-code>|(?:Booking code|Mã đặt lịch):\s*\*\*([A-Z0-9]{8})\*\*|\[cancel:[^|]+\|([A-Z0-9]{8})\]|\b([A-Z0-9]{8})\b/gi,
    ),
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4],
  )
    .reverse()
    .find((code) => !cancelledCodes.has(code));
};

export const extractPhoneFromText = (text: string): string | null => {
  const match = text.match(/(?:\+84|84|0)?\s*([0-9](?:[\s.-]*\d){6,14})\b/);
  if (!match) {
    const digits = text.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      return digits;
    }
    return null;
  }
  const digitsOnly = match[0].replace(/[\s.-]/g, '');
  if (digitsOnly.startsWith('+84')) {
    return `0${digitsOnly.slice(3)}`;
  }
  if (digitsOnly.startsWith('84') && digitsOnly.length >= 10) {
    return `0${digitsOnly.slice(2)}`;
  }
  return digitsOnly;
};

/**
 * Normalizes phone numbers for comparison (strips non-digits and maps country codes).
 */
export const normalizePhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('84') && digits.length >= 10) {
    return `0${digits.slice(2)}`;
  }
  return digits;
};
