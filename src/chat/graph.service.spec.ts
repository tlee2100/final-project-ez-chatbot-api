import {
  extractBookingCode,
  extractPhoneFromText,
  latestActiveBookingCode,
  normalizePhone,
} from './booking-cancellation.utils';
import {
  bookingCodeText,
  bookAppointmentToolNames,
  detectBookingTriggerLocale,
  detectSmallTalkLocale,
  enforceBookingChipScope,
  extractRequestedTimeSlot,
  isBookingAbandonment,
  isBookingFlowIntent,
  isBookingSlotSelection,
  isNaturalBookingTrigger,
  isSmallTalkTrigger,
  isTimeSlotAvailable,
  parseBookingSlotSelection,
  parseKnowledgeSearchOutput,
  shouldContinueBookingFlow,
  stripReasoningContent,
  stripRenderedSlotTimes,
} from './chat-flow.utils';
import { buildToolSchema } from './tool-schema.utils';
import {
  getCancelPrompts,
  getAbandonBookingPrompt,
  getBookingOptionPrompt,
  getIntentClassifierPrompt,
  getKnowledgeFallbackPrompt,
  getKnowledgeGroundingRule,
  getOutOfScopePrompt,
  getPublicCapabilitiesPrompt,
} from './prompts';

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

  it('reads booking codes from bold display text and old metadata', () => {
    const history = [
      '<booking-code>AB12CD34</booking-code>',
      'Booking code: **ON11204M**',
    ].join('\n');

    expect(latestActiveBookingCode(history)).toBe('ON11204M');
  });
});

describe('booking cancellation phone utilities', () => {
  it('extracts supported phone formats', () => {
    expect(extractPhoneFromText('SĐT của tôi là 0912345678')).toBe(
      '0912345678',
    );
    expect(extractPhoneFromText('Số điện thoại: +84912345678')).toBe(
      '0912345678',
    );
    expect(extractPhoneFromText('038 123 4567')).toBe('0381234567');
    expect(extractPhoneFromText('không có số nào ở đây')).toBeNull();
  });

  it('normalizes Vietnamese phone strings', () => {
    expect(normalizePhone('+84912345678')).toBe('0912345678');
    expect(normalizePhone('84912345678')).toBe('0912345678');
    expect(normalizePhone('0912-345-678')).toBe('0912345678');
  });
});

describe('booking cancellation prompts', () => {
  it('selects deterministic prompt catalogs by locale', () => {
    expect(getCancelPrompts('vi').askCode).toContain('mã đặt lịch');
    expect(getCancelPrompts('en').askCode).toContain('booking code');
    expect(getCancelPrompts('ja-JP').askCode).toContain('予約コード');
    expect(getCancelPrompts('fr').askCode).toBe(getCancelPrompts('en').askCode);
  });
});

describe('booking chat flow guards', () => {
  it('preserves MCP JSON Schema argument types', () => {
    const schema = buildToolSchema({
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'integer' },
        includeDrafts: { type: 'boolean' },
      },
      required: ['query'],
    });

    expect(
      schema.safeParse({ query: 'zodishop', topK: 5, includeDrafts: false })
        .success,
    ).toBe(true);
    expect(schema.safeParse({ query: 'zodishop', topK: '5' }).success).toBe(
      false,
    );
  });

  it('extracts a requested time and checks MCP slot output', () => {
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
    expect(bookingCodeText('ON11204M')).toBe('\n\n**ON11204M**');
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

  it('parses structured slot selections as authoritative data', () => {
    const raw =
      '/select-booking-slot {"date":"2026-08-20","timeSlot":"14:00","resourceId":"res-1","language":"ja-JP"} :: 14:00';

    expect(isBookingSlotSelection(raw)).toBe(true);
    expect(parseBookingSlotSelection(raw)).toEqual({
      date: '2026-08-20',
      timeSlot: '14:00',
      resourceId: 'res-1',
      language: 'ja-JP',
    });
  });

  it('classifies ambiguous values as booking continuation during a flow', () => {
    const prompt = getIntentClassifierPrompt(true, true);
    expect(prompt).toContain('value alone is ambiguous');
    expect(prompt).toContain('canonical BCP 47');
    expect(prompt).toContain('system_question');
    expect(prompt).toContain('out_of_scope');
  });

  it('refuses out-of-scope work without invoking the main model', () => {
    const response = getOutOfScopePrompt('vi', true);

    expect(response).toContain('doanh nghiệp này');
    expect(response).toContain('đặt lịch');
    expect(response).not.toContain('C++');
  });

  it('answers internal-system questions with public capabilities only', () => {
    const response = getPublicCapabilitiesPrompt('vi', true);

    expect(response).toContain('thông tin công khai');
    expect(response).not.toMatch(
      /searchKnowledge|getSiteConfig|holdSlot|draftBooking|createBooking/,
    );
  });

  it('continues booking for small talk and exact database entity values', () => {
    const siteContext = {
      bookingServices: [{ name: 'goi dau' }],
      bookingResources: [{ name: 'hieu' }],
    };

    expect(shouldContinueBookingFlow('BOOKING', 'small_talk')).toBe(true);
    expect(
      shouldContinueBookingFlow('BOOKING', 'question', 'HIEU', siteContext),
    ).toBe(true);
    expect(
      shouldContinueBookingFlow(
        'BOOKING',
        'question',
        'hieu có làm hôm nay không?',
        siteContext,
      ),
    ).toBe(false);
    expect(shouldContinueBookingFlow('BOOKING', 'cancel_booking')).toBe(false);
    expect(shouldContinueBookingFlow('BOOKING', 'abandon_booking')).toBe(false);
    expect(shouldContinueBookingFlow(null, 'small_talk')).toBe(false);
  });

  it('recognizes explicit unfinished-booking exits without confusing cancellation', () => {
    expect(isBookingAbandonment('thôi')).toBe(true);
    expect(isBookingAbandonment('I no longer want to book')).toBe(true);
    expect(isBookingAbandonment('exit booking')).toBe(true);
    expect(isBookingAbandonment('hủy lịch AB12CD34')).toBe(false);
    expect(isBookingAbandonment('đổi nhân viên')).toBe(false);
  });

  it('uses deterministic localized booking exit and RAG fallback messages', () => {
    expect(getAbandonBookingPrompt('vi')).toBe('Đã dừng quá trình đặt lịch.');
    expect(getKnowledgeFallbackPrompt('en', false)).toContain(
      'could not find relevant information',
    );
    expect(getKnowledgeFallbackPrompt('en', true)).toContain(
      'cannot search the knowledge base',
    );
  });

  it('uses a deterministic prompt when booking model text is empty', () => {
    expect(getBookingOptionPrompt('en', 'service')).toBe(
      'Which service would you like to book?',
    );
    expect(getBookingOptionPrompt('vi', 'resource')).toContain('nhân viên');
  });

  it('classifies knowledge tool output without letting errors reach the model', () => {
    expect(
      parseKnowledgeSearchOutput(
        JSON.stringify({ chunks: [{ content: 'KB fact' }] }),
      ),
    ).toEqual({ status: 'success', chunks: [{ content: 'KB fact' }] });
    expect(parseKnowledgeSearchOutput({ chunks: [] })).toEqual({
      status: 'empty',
      chunks: [],
    });
    expect(parseKnowledgeSearchOutput({ error: 'MCP unavailable' })).toEqual({
      status: 'error',
      chunks: [],
    });
    expect(
      parseKnowledgeSearchOutput({
        result: 'MCP error -32602: Input validation error',
      }),
    ).toEqual({ status: 'error', chunks: [] });
    expect(parseKnowledgeSearchOutput('not-json')).toEqual({
      status: 'error',
      chunks: [],
    });
  });

  it('uses KB chunks first and only falls back to trusted context when empty', () => {
    const grounded = getKnowledgeGroundingRule('success');
    expect(grounded).toContain('only from those searchKnowledge chunks');
    expect(grounded).toContain('primary source of truth');

    const empty = getKnowledgeGroundingRule('empty');
    expect(empty).toContain('trusted SITE CONTEXT');
    expect(empty).toContain('Never fill gaps');
  });

  it('allows chips only for strict booking intents', () => {
    expect(isBookingFlowIntent('book_appointment')).toBe(true);
    expect(isBookingFlowIntent('book_appointment_init')).toBe(true);
    expect(isBookingFlowIntent('structured_booking_step')).toBe(true);
    expect(isBookingFlowIntent('booking_slot_selected')).toBe(true);
    expect(isBookingFlowIntent('question')).toBe(false);
    expect(isBookingFlowIntent('cancel_booking')).toBe(false);
    expect(isBookingFlowIntent('out_of_scope')).toBe(false);
    expect(
      enforceBookingChipScope('Choose one <chips>Yes|No</chips>', 'question'),
    ).toBe('Choose one');
    expect(
      enforceBookingChipScope(
        'Choose one <chips>Service A|Service B</chips>',
        'book_appointment',
      ),
    ).toContain('<chips>');
  });

  it('removes textual time lists when the widget renders a slot card', () => {
    const response = [
      'Các khung giờ còn trống được hiển thị bên dưới:',
      '09:00, 09:30, 10:00, 10:30.',
      'Vui lòng chọn một khung giờ phù hợp để tiếp tục.',
    ].join('\n\n');

    expect(stripRenderedSlotTimes(response)).toBe(
      [
        'Các khung giờ còn trống được hiển thị bên dưới:',
        'Vui lòng chọn một khung giờ phù hợp để tiếp tục.',
      ].join('\n\n'),
    );
  });

  it('removes provider reasoning before displaying or saving a response', () => {
    expect(
      stripReasoningContent(
        'The user is asking for site information. </think>\n\nTôi có thể giúp bạn.',
      ).trim(),
    ).toBe('Tôi có thể giúp bạn.');
    expect(
      stripReasoningContent('<think>secret</think>Câu trả lời').trim(),
    ).toBe('Câu trả lời');
  });

  it('detects natural booking triggers and their locale fast-path', () => {
    expect(detectBookingTriggerLocale('đặt lịch')).toBe('vi');
    expect(detectBookingTriggerLocale('Đặt lịch hẹn')).toBe('vi');
    expect(detectBookingTriggerLocale('tôi muốn book lịch')).toBe('vi');
    expect(detectBookingTriggerLocale('mình muốn đặt lịch')).toBe('vi');
    expect(detectBookingTriggerLocale('đặt')).toBe('vi');
    expect(detectBookingTriggerLocale('book')).toBe('en');
    expect(detectBookingTriggerLocale('book', 'vi')).toBe('vi');
    expect(detectBookingTriggerLocale('book appointment')).toBe('en');
    expect(detectBookingTriggerLocale('I want to book an appointment')).toBe(
      'en',
    );
    expect(detectBookingTriggerLocale('予約したい')).toBe('ja');
    expect(detectBookingTriggerLocale('予約')).toBe('ja');

    expect(isNaturalBookingTrigger('đặt lịch')).toBe(true);
    expect(isNaturalBookingTrigger('book')).toBe(true);
    expect(isNaturalBookingTrigger('booking')).toBe(true);
    expect(isNaturalBookingTrigger('book appointment')).toBe(true);
    expect(isNaturalBookingTrigger('giá dịch vụ là bao nhiêu')).toBe(false);
    expect(isNaturalBookingTrigger('hello')).toBe(false);
  });

  it('detects small talk greetings and meta-question triggers', () => {
    expect(detectSmallTalkLocale('hi')).toBe('en');
    expect(detectSmallTalkLocale('hi', 'vi')).toBe('vi');
    expect(detectSmallTalkLocale('xin chào')).toBe('vi');
    expect(detectSmallTalkLocale('chào bạn')).toBe('vi');
    expect(detectSmallTalkLocale('đặt một câu hỏi')).toBe('vi');
    expect(detectSmallTalkLocale('cho mình hỏi')).toBe('vi');
    expect(detectSmallTalkLocale('tôi có một câu hỏi')).toBe('vi');
    expect(detectSmallTalkLocale('cần tư vấn')).toBe('vi');
    expect(detectSmallTalkLocale('can I ask a question')).toBe('en');
    expect(detectSmallTalkLocale('I have a question')).toBe('en');
    expect(detectSmallTalkLocale('こんにちは')).toBe('ja');
    expect(detectSmallTalkLocale('質問があります')).toBe('ja');

    expect(isSmallTalkTrigger('đặt một câu hỏi')).toBe(true);
    expect(isSmallTalkTrigger('cho mình hỏi')).toBe(true);
    expect(isSmallTalkTrigger('hi')).toBe(true);
    expect(isSmallTalkTrigger('can I ask a question')).toBe(true);
    expect(isSmallTalkTrigger('giá dịch vụ cắt tóc là bao nhiêu')).toBe(false);
  });
});
