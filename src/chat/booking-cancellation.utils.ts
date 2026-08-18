export const extractBookingCode = (text: string) =>
  text.match(/^\/(?:confirm-)?cancel-booking\s+(\S+)/i)?.[1] ??
  text.match(/\b(?:code|mã)\s*[:#-]?\s*([a-z0-9]{8})\b/i)?.[1] ??
  text.match(/\b[A-Z0-9]{8}\b/)?.[0];

export const latestActiveBookingCode = (content: string) => {
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
