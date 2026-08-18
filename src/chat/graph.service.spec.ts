import {
  extractBookingCode,
  latestActiveBookingCode,
} from './booking-cancellation.utils';
import {
  detectConversationLanguage,
  generateDateChips,
  isBookingSlotSelection,
  parseBookingSlotSelection,
  replacePseudoToolResponse,
  sanitizeBookingChips,
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
  it('detects conversation language without false triggers from service or staff names', () => {
    const siteContext = {
      bookingServices: [{ name: 'cat toc' }, { name: 'goi dau' }],
      bookingResources: [{ name: 'Nghi' }, { name: 'Hiếu' }],
    };

    // User starts with "book" (English) and then selects "cat toc" (service name)
    const messages = [
      { role: 'user', content: 'book' },
      {
        role: 'assistant',
        content:
          "I'd be happy to help you book an appointment! Which service would you like?",
      },
      { role: 'user', content: 'cat toc' },
    ];

    expect(detectConversationLanguage(messages, siteContext)).toBe('en');

    // Vietnamese conversation
    const viMessages = [
      { role: 'user', content: 'Tôi muốn đặt lịch' },
      { role: 'assistant', content: 'Bạn muốn làm dịch vụ nào?' },
      { role: 'user', content: 'cat toc' },
    ];
    expect(detectConversationLanguage(viMessages, siteContext)).toBe('vi');
  });

  it('parses a widget slot selection as authoritative booking data', () => {
    const raw =
      '/select-booking-slot {"date":"2026-08-20","timeSlot":"14:00","resourceId":"res-1","language":"vi"} :: Chọn 14:00';
    expect(isBookingSlotSelection(raw)).toBe(true);
    expect(parseBookingSlotSelection(raw)).toEqual({
      date: '2026-08-20',
      timeSlot: '14:00',
      resourceId: 'res-1',
      language: 'vi',
    });
  });

  it('replaces tool syntax accidentally emitted as small-talk text', () => {
    expect(replacePseudoToolResponse('<getSiteConfig>', true)).toBe(
      'Xin chào! Tôi có thể giúp gì cho bạn?',
    );
    expect(replacePseudoToolResponse('<getSiteConfig>', false)).toBe(
      'Hi! How can I help you today?',
    );
  });
  it('replaces booking data accidentally exposed in small talk', () => {
    const text = 'Xin chào, chúng tôi có các dịch vụ: Cắt tóc, Gội đầu.';
    const result = sanitizeSmallTalkResponse(text, true, {
      name: 'EZ Salon',
      bookingServices: [{ name: 'Cắt tóc' }, { name: 'Gội đầu' }],
    });
    expect(result).toBe(
      'Xin chào! Chào mừng bạn đến với EZ Salon. Tôi có thể giúp gì cho bạn?',
    );
  });

  it('generates date chips correctly', () => {
    const fixedNow = new Date('2026-08-16T12:00:00.000Z');
    const viChips = generateDateChips(
      { availableDays: [1, 2, 3, 4, 5, 6, 7] },
      true,
      fixedNow,
    );
    expect(viChips).toHaveLength(6);
    expect(viChips[0]).toContain('Hôm nay');
    expect(viChips[5]).toBe('Chọn ngày khác');

    const enChips = generateDateChips(
      { availableDays: [1, 2, 3, 4, 5, 6, 7] },
      false,
      fixedNow,
    );
    expect(enChips).toHaveLength(6);
    expect(enChips[0]).toContain('Today');
    expect(enChips[5]).toBe('Choose another date');
  });

  it('sanitizes chips based on the active question being asked at the end of text', () => {
    const siteContext = {
      bookingEnabled: true,
      bookingServices: [{ name: 'Gội đầu' }, { name: 'Cắt tóc' }],
      bookingResources: [{ name: 'Nghi' }, { name: 'Hiếu' }],
      bookingHours: {
        availableDays: [1, 2, 3, 4, 5, 6, 7],
        endTime: '23:59',
        timezone: 'Asia/Ho_Chi_Minh',
      },
    };

    // 1. Acknowledging stylist and asking for date -> Should have DATE chips, NOT stylist chips
    const dateQuestion =
      'Cảm ơn! Bạn đã chọn stylist **Nghi**. Bạn muốn đặt lịch vào ngày nào?\n\n<chips>Nghi|Hiếu|Không ưu tiên</chips>';
    const sanitizedDateResponse = sanitizeBookingChips(
      dateQuestion,
      siteContext,
    );
    expect(sanitizedDateResponse).toContain('Chọn ngày khác');
    expect(sanitizedDateResponse).not.toContain('Không ưu tiên');

    // 2. Acknowledging service and asking for stylist -> Should have STAFF chips
    const staffQuestion =
      'Tuyệt vời! Bạn đã chọn dịch vụ **Gội đầu**. Bạn có stylist mong muốn không?\n\n<chips>Gội đầu|Cắt tóc</chips>';
    const sanitizedStaffResponse = sanitizeBookingChips(
      staffQuestion,
      siteContext,
    );
    expect(sanitizedStaffResponse).toContain(
      '<chips>Nghi|Hiếu|Không ưu tiên</chips>',
    );

    // 3. Asking for Name -> If no visitor name, strips chips; if visitor name provided, shows name chip
    const nameQuestion =
      'Cảm ơn bạn! Bạn tên là gì?\n\n<chips>Nghi|Hiếu|Không ưu tiên</chips>';
    expect(sanitizeBookingChips(nameQuestion, siteContext)).toBe(
      'Cảm ơn bạn! Bạn tên là gì?',
    );
    expect(
      sanitizeBookingChips(nameQuestion, siteContext, { name: 'Tân Lê' }),
    ).toBe('Cảm ơn bạn! Bạn tên là gì?\n\n<chips>Tân Lê</chips>');

    // 4. Asking for Phone -> Should strip chips
    const phoneQuestion =
      'Vui lòng cho biết số điện thoại của bạn?\n\n<chips>Nghi|Hiếu</chips>';
    expect(sanitizeBookingChips(phoneQuestion, siteContext)).toBe(
      'Vui lòng cho biết số điện thoại của bạn?',
    );

    // 5. Asking for Email -> Should have Skip chip, and visitor email chip if available
    const emailQuestion =
      'Bạn có muốn nhận email xác nhận không? Bạn có thể nhập email hoặc bấm Bỏ qua.\n\n<chips>Nghi|Hiếu</chips>';
    expect(sanitizeBookingChips(emailQuestion, siteContext)).toContain(
      '<chips>Bỏ qua</chips>',
    );
    expect(
      sanitizeBookingChips(emailQuestion, siteContext, {
        email: 'test@gmail.com',
      }),
    ).toContain('<chips>test@gmail.com|Bỏ qua</chips>');

    // 6. English conversation with Vietnamese service/staff -> preserves English chips
    const enStaffQuestion =
      'Great! You selected **cat toc**. Do you have a preferred stylist?\n\n<chips>cat toc|goi dau</chips>';
    const sanitizedEnStaff = sanitizeBookingChips(
      enStaffQuestion,
      siteContext,
      undefined,
      'en',
    );
    expect(sanitizedEnStaff).toContain(
      '<chips>Nghi|Hiếu|No Preference</chips>',
    );
  });
});
