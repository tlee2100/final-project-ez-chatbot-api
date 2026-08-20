import {
  extractBookingCode,
  latestActiveBookingCode,
  extractPhoneFromText,
  normalizePhone,
} from './booking-cancellation.utils';
import {
  bookingCodeText,
  bookAppointmentToolNames,
  detectConversationLanguage,
  extractRequestedTimeSlot,
  generateDateChips,
  isBookingPhonePrompt,
  isBookingSlotSelection,
  isDraftBookingAbandonment,
  isTimeSlotAvailable,
  parseBookingSlotSelection,
  replacePseudoToolResponse,
  sanitizeBookingChips,
  sanitizeSmallTalkResponse,
} from './chat-flow.utils';
import { getCancelPrompts } from './prompts';

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

  it('reads booking codes from bold display text while supporting old messages', () => {
    const history = [
      '<booking-code>AB12CD34</booking-code>',
      'Booking code: **ON11204M**',
    ].join('\n');

    expect(latestActiveBookingCode(history)).toBe('ON11204M');
  });
});

describe('booking cancellation phone utilities', () => {
  it('extracts Vietnamese phone numbers with various prefixes and formats', () => {
    expect(extractPhoneFromText('SĐT của tôi là 0912345678')).toBe(
      '0912345678',
    );
    expect(extractPhoneFromText('Số điện thoại: +84912345678')).toBe(
      '0912345678',
    );
    expect(extractPhoneFromText('84912345678')).toBe('0912345678');
    expect(extractPhoneFromText('038 123 4567')).toBe('0381234567');
    expect(extractPhoneFromText('079-123-4567')).toBe('0791234567');
    expect(extractPhoneFromText('không có số nào ở đây')).toBeNull();
    expect(extractPhoneFromText('12345')).toBeNull();
  });

  it('normalizes phone strings correctly', () => {
    expect(normalizePhone('+84912345678')).toBe('0912345678');
    expect(normalizePhone('84912345678')).toBe('0912345678');
    expect(normalizePhone('0912 345 678')).toBe('0912345678');
    expect(normalizePhone('0912-345-678')).toBe('0912345678');
  });
});

describe('booking cancellation prompts', () => {
  it('returns Vietnamese cancellation prompts when isVietnamese is true', () => {
    const viPrompts = getCancelPrompts(true);
    expect(viPrompts.askCode).toContain('mã đặt lịch');
    expect(viPrompts.verifyPhone).toContain('số điện thoại');
    expect(viPrompts.phoneWrong).toContain('không khớp');
    expect(viPrompts.confirmCancel).toContain('xác nhận');
    expect(viPrompts.keepConfirmed).toContain('giữ nguyên');
    expect(viPrompts.cancelSuccess).toContain('thành công');
    expect(viPrompts.cancelFail).toContain('Không thể hủy');
    expect(viPrompts.alreadyCancelled).toContain('đã được hủy trước đó');
    expect(viPrompts.notFound).toContain('Không tìm thấy');
  });

  it('returns English cancellation prompts when isVietnamese is false', () => {
    const enPrompts = getCancelPrompts(false);
    expect(enPrompts.askCode).toContain('booking code');
    expect(enPrompts.verifyPhone).toContain('phone number');
    expect(enPrompts.phoneWrong).toContain('does not match');
    expect(enPrompts.confirmCancel).toContain('confirm');
    expect(enPrompts.keepConfirmed).toContain('kept');
    expect(enPrompts.cancelSuccess).toContain('successfully cancelled');
    expect(enPrompts.cancelFail).toContain('Unable to cancel');
    expect(enPrompts.alreadyCancelled).toContain('already been cancelled');
    expect(enPrompts.notFound).toContain('No booking found');
  });
});

describe('booking chat flow guards', () => {
  it('extracts a requested time and checks it against MCP slot output', () => {
    expect(extractRequestedTimeSlot('Book on 29/08/2026 at 2:30 PM')).toBe(
      '14:30',
    );
    expect(extractRequestedTimeSlot('đặt lúc 9h05')).toBe('09:05');

    const output = {
      result: [
        { timeSlot: '09:00', available: true },
        { timeSlot: '14:30', available: true },
      ],
    };
    expect(isTimeSlotAvailable(output, '14:30')).toBe(true);
    expect(isTimeSlotAvailable(output, '15:00')).toBe(false);
    expect(isTimeSlotAvailable({ error: 'failed' }, '14:30')).toBeUndefined();
  });

  it('formats the booking code as bold display text', () => {
    expect(bookingCodeText('ON11204M', false)).toBe(
      '\n\nBooking code: **ON11204M**',
    );
    expect(bookingCodeText('ON11204M', true)).toContain(
      'Mã đặt lịch: **ON11204M**',
    );
  });

  it('marks phone prompts without depending on the widget language', () => {
    expect(isBookingPhonePrompt('Please provide your phone number.')).toBe(
      true,
    );
    expect(isBookingPhonePrompt('Bạn cho mình xin số điện thoại nhé?')).toBe(
      true,
    );
    expect(isBookingPhonePrompt('Would you like a confirmation email?')).toBe(
      false,
    );
  });

  it('only exposes createBooking for an explicit confirmation command', () => {
    expect(bookAppointmentToolNames('customer@example.com')).toContain(
      'draftBooking',
    );
    expect(bookAppointmentToolNames('customer@example.com')).not.toContain(
      'createBooking',
    );
    expect(
      bookAppointmentToolNames('/update-draft-booking {"phone":"0912345678"}'),
    ).toEqual(['draftBooking']);
    expect(
      bookAppointmentToolNames('/confirm-booking {"phone":"0912345678"}'),
    ).toEqual(['createBooking']);
  });

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

    const afterEnglishBooking = [
      ...messages,
      {
        role: 'assistant',
        content: 'Your appointment is confirmed!\n\nBooking code: **AB12CD34**',
      },
      {
        role: 'user',
        content: 'b\u1ea1n th\u1ea5y t\u00f4i th\u1ebf n\u00e0o',
      },
    ];
    expect(detectConversationLanguage(afterEnglishBooking, siteContext)).toBe(
      'vi',
    );

    const switchedDuringDraft = [
      ...messages,
      {
        role: 'user',
        content: 'b\u1ea1n th\u1ea5y t\u00f4i th\u1ebf n\u00e0o',
      },
    ];
    expect(detectConversationLanguage(switchedDuringDraft, siteContext)).toBe(
      'en',
    );
    expect(
      detectConversationLanguage(switchedDuringDraft, siteContext, true),
    ).toBe('vi');

    const vietnameseCancellation = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello! How can I assist you today?' },
      { role: 'user', content: 'hủy lịch EZHOS1J8' },
      { role: 'assistant', content: 'Vui lòng nhập số điện thoại.' },
      { role: 'user', content: '0963258741' },
    ];
    expect(
      detectConversationLanguage(vietnameseCancellation, siteContext, true),
    ).toBe('vi');
  });

  it('recognizes abandoning an unfinished booking without treating cancellation as abandonment', () => {
    expect(isDraftBookingAbandonment('thôi tôi không muốn đặt nữa')).toBe(true);
    expect(isDraftBookingAbandonment("I don't want to book anymore")).toBe(
      true,
    );
    expect(isDraftBookingAbandonment('cancel booking AB12CD34')).toBe(false);
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

  it('does not match a short resource name inside another word', () => {
    const text =
      "I'm just an AI assistant. Is there anything else I can help with?";

    expect(
      sanitizeSmallTalkResponse(text, false, {
        bookingResources: [{ name: 'tan' }],
      }),
    ).toBe(text);
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

    const mismatchedDateResponse = sanitizeBookingChips(
      'Cảm ơn bạn! Bạn đã chọn stylist **Dần**.\n\nBạn muốn đặt lịch vào ngày nào?\n\n<chips>Today|Choose another date</chips>',
      {
        ...siteContext,
        bookingResources: [...siteContext.bookingResources, { name: 'Dần' }],
      },
      undefined,
      'en',
    );
    expect(mismatchedDateResponse).toContain('Chọn ngày khác');
    expect(mismatchedDateResponse).not.toContain('Choose another date');

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
