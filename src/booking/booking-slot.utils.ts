import { fromZonedTime } from 'date-fns-tz';

export interface SelectedSlotInput {
  resourceId: string;
  date: string; // 'YYYY-MM-DD'
  timeSlot: string; // 'HH:mm'
  serviceId?: string;
  notes?: string;
  note?: string;
}

export interface GroupedBookingSpan {
  resourceId: string;
  date: string;
  startTimeSlot: string;
  endTimeSlot: string;
  startAt: string; // ISO UTC
  endAt: string; // ISO UTC
  slotCount: number;
  serviceIds: string[];
  slotNotes: string[];
  slots: SelectedSlotInput[];
}

/**
 * Parses HH:mm string to minutes from 00:00
 */
export function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Formats minutes from 00:00 to HH:mm string
 */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Groups consecutive slots on the same resource into single spans,
 * and leaves disjoint slots or different resources as separate spans.
 */
export function groupConsecutiveSlots(
  slots: SelectedSlotInput[],
  slotDuration: number,
  timezone: string,
): GroupedBookingSpan[] {
  if (!slots || slots.length === 0) return [];

  // Group slots by resourceId and date
  const byResourceAndDate = new Map<string, SelectedSlotInput[]>();

  for (const slot of slots) {
    const key = `${slot.resourceId}__${slot.date}`;
    const list = byResourceAndDate.get(key) ?? [];
    list.push(slot);
    byResourceAndDate.set(key, list);
  }

  const resultSpans: GroupedBookingSpan[] = [];

  for (const [, resourceSlots] of byResourceAndDate.entries()) {
    // Sort chronologically
    const sorted = [...resourceSlots].sort(
      (a, b) => timeToMinutes(a.timeSlot) - timeToMinutes(b.timeSlot),
    );

    let currentSpan: {
      resourceId: string;
      date: string;
      startTimeSlot: string;
      endTimeSlot: string;
      slotCount: number;
      serviceIds: string[];
      slotNotes: string[];
      slots: SelectedSlotInput[];
    } | null = null;

    for (const slot of sorted) {
      const slotStartMins = timeToMinutes(slot.timeSlot);
      const slotEndMins = slotStartMins + slotDuration;
      const expectedEndTime = minutesToTime(slotEndMins);
      const note = (slot.notes || slot.note || '').trim();

      if (!currentSpan) {
        currentSpan = {
          resourceId: slot.resourceId,
          date: slot.date,
          startTimeSlot: slot.timeSlot,
          endTimeSlot: expectedEndTime,
          slotCount: 1,
          serviceIds: slot.serviceId ? [slot.serviceId] : [],
          slotNotes: note ? [note] : [],
          slots: [slot],
        };
      } else {
        const currentEndMins = timeToMinutes(currentSpan.endTimeSlot);
        if (slotStartMins === currentEndMins) {
          // Consecutive! Extend the current span
          currentSpan.endTimeSlot = expectedEndTime;
          currentSpan.slotCount += 1;
          if (slot.serviceId) {
            currentSpan.serviceIds.push(slot.serviceId);
          }
          if (note) {
            currentSpan.slotNotes.push(note);
          }
          currentSpan.slots.push(slot);
        } else {
          // Disjoint! Push current and start a new one
          const localStartStr = `${currentSpan.date}T${currentSpan.startTimeSlot}:00`;
          const localEndStr = `${currentSpan.date}T${currentSpan.endTimeSlot}:00`;
          const utcStart = fromZonedTime(localStartStr, timezone).toISOString();
          const utcEnd = fromZonedTime(localEndStr, timezone).toISOString();

          resultSpans.push({
            ...currentSpan,
            startAt: utcStart,
            endAt: utcEnd,
          });

          currentSpan = {
            resourceId: slot.resourceId,
            date: slot.date,
            startTimeSlot: slot.timeSlot,
            endTimeSlot: expectedEndTime,
            slotCount: 1,
            serviceIds: slot.serviceId ? [slot.serviceId] : [],
            slotNotes: note ? [note] : [],
            slots: [slot],
          };
        }
      }
    }

    if (currentSpan) {
      const localStartStr = `${currentSpan.date}T${currentSpan.startTimeSlot}:00`;
      const localEndStr = `${currentSpan.date}T${currentSpan.endTimeSlot}:00`;
      const utcStart = fromZonedTime(localStartStr, timezone).toISOString();
      const utcEnd = fromZonedTime(localEndStr, timezone).toISOString();

      resultSpans.push({
        ...currentSpan,
        startAt: utcStart,
        endAt: utcEnd,
      });
    }
  }

  return resultSpans;
}
