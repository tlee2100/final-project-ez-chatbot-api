import {
  extractBookingCode,
  latestActiveBookingCode,
} from './booking-cancellation.utils';
import {
  isBookingSlotSelection,
  parseBookingSlotSelection,
  replacePseudoToolResponse,
  sanitizeSmallTalkResponse,
} from './chat-flow.utils';

describe('booking cancellation code resolution', () => {
  it('extracts codes from widget commands and visitor messages', () => {
    expect(extractBookingCode('/cancel-booking HM1GA5NS :: Cancel')).toBe(
      'HM1GA5NS',
    );
    expect(extractBookingCode('Hủy lịch có mã AB12CD34')).toBe('AB12CD34');
  });

  it('returns the latest booking that has not been cancelled', () => {
    const history = [
      '<booking-code>AB12CD34</booking-code>',
      '<booking-code>EF56GH78</booking-code>',
      '<booking-cancelled>EF56GH78</booking-cancelled>',
    ].join('\n');

    expect(latestActiveBookingCode(history)).toBe('AB12CD34');
  });
});

describe('booking chat flow guards', () => {
  const command =
    '/select-booking-slot {"date":"2026-08-13","timeSlot":"19:30","resourceId":"resource-1","language":"vi"} :: Tôi chọn 19:30';

  it('parses a widget slot selection as authoritative booking data', () => {
    expect(isBookingSlotSelection(command)).toBe(true);
    expect(parseBookingSlotSelection(command)).toEqual({
      date: '2026-08-13',
      timeSlot: '19:30',
      resourceId: 'resource-1',
      language: 'vi',
    });
  });

  it('replaces tool syntax accidentally emitted as small-talk text', () => {
    expect(replacePseudoToolResponse('<getSiteConfig>', false)).toBe(
      'Hi! How can I help you today?',
    );
  });

  it('replaces booking data accidentally exposed in small talk', () => {
    expect(
      sanitizeSmallTalkResponse(
        'Let me check our services. <chips>Haircut|Massage</chips>',
        false,
        {
          name: 'Beauty Salon',
          bookingServices: [{ name: 'Haircut' }, { name: 'Massage' }],
        },
      ),
    ).toBe('Hello! Welcome to Beauty Salon. How can I assist you today?');
  });
});
