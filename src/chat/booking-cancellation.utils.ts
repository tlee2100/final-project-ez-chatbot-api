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
    content.matchAll(/<booking-code>(.*?)<\/booking-code>/g),
    (match) => match[1],
  )
    .reverse()
    .find((code) => !cancelledCodes.has(code));
};

/**
 * Extracts and normalizes a Vietnamese phone number from text.
 * Supports formats starting with +84, 84, or 0 followed by 9 digits.
 */
export const extractPhoneFromText = (text: string): string | null => {
  const match = text.match(/(?:\+84|84|0)\s*([35789](?:[\s.-]*\d){8})\b/);
  if (!match) return null;
  const digitsOnly = match[1].replace(/\D/g, '');
  return `0${digitsOnly}`;
};

/**
 * Normalizes phone numbers to standard 0xxxxxxxxx format for comparison.
 */
export const normalizePhone = (phone: string): string =>
  phone.replace(/\D/g, '').replace(/^84/, '0');
