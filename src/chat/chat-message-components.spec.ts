import {
  bookingOptionNeedsModel,
  buildChatMessageComponents,
  extractBookingCommandJson,
  hasActiveStructuredBookingProgress,
  parseBookingOptionSelection,
  stripModelBookingDirectives,
} from './chat-message-components';

describe('chat message components', () => {
  const siteContext = {
    bookingEnabled: true,
    bookingServices: [
      { id: 'service-1', name: 'goi dau' },
      { id: 'service-2', name: 'cat toc' },
      { id: 'service-3', name: 'cao long' },
    ],
    bookingResources: [
      { id: 'resource-1', name: 'hieu' },
      { id: 'resource-2', name: 'Dần' },
    ],
  };

  it('builds the complete service list from backend data', () => {
    const components = buildChatMessageComponents(
      'Choose a service. <booking-step>service</booking-step>',
      siteContext,
    );

    expect(components[0].items).toEqual([
      { action: 'select_service', value: 'service-1', label: 'goi dau' },
      { action: 'select_service', value: 'service-2', label: 'cat toc' },
      { action: 'select_service', value: 'service-3', label: 'cao long' },
    ]);
  });

  it('ignores model-authored chips and preserves exact DB names', () => {
    const text =
      'Choose a service. <chips>gội đầu|gội đầu</chips><booking-step>service</booking-step>';

    expect(buildChatMessageComponents(text, siteContext)[0].items).toEqual([
      { action: 'select_service', value: 'service-1', label: 'goi dau' },
      { action: 'select_service', value: 'service-2', label: 'cat toc' },
      { action: 'select_service', value: 'service-3', label: 'cao long' },
    ]);
    expect(stripModelBookingDirectives(text)).toBe('Choose a service.');
  });

  it('falls back to backend service options when the model returns only invalid markup', () => {
    const components = buildChatMessageComponents(
      '<chips><button action="select_service" label="goi dau"></button></chips>',
      siteContext,
      undefined,
      new Date(),
      'book',
      'service',
    );

    expect(components[0].items).toEqual([
      { action: 'select_service', value: 'service-1', label: 'goi dau' },
      { action: 'select_service', value: 'service-2', label: 'cat toc' },
      { action: 'select_service', value: 'service-3', label: 'cao long' },
    ]);
  });

  it('builds every staff option after a structured service selection', () => {
    const components = buildChatMessageComponents(
      'Choose staff.',
      siteContext,
      undefined,
      new Date(),
      '/select-booking-option {"action":"select_service","value":"service-1","locale":"vi"} :: goi dau',
    );

    expect(components[0].items).toEqual([
      { action: 'select_resource', value: 'resource-1', label: 'hieu' },
      { action: 'select_resource', value: 'resource-2', label: 'Dần' },
      { action: 'no_preference', labelKey: 'chip.noPreference' },
    ]);
  });

  it('builds date actions from backend booking state', () => {
    const components = buildChatMessageComponents(
      'Which date would you like?',
      {
        ...siteContext,
        bookingHours: {
          timezone: 'UTC',
          availableDays: [1, 2, 3, 4, 5, 6],
        },
      },
      undefined,
      new Date('2026-08-20T08:00:00.000Z'),
      '/select-booking-option {"action":"select_resource","value":"resource-1","locale":"en"} :: hieu',
    );

    expect(
      components[0].items.map(({ action, value }) => ({ action, value })),
    ).toEqual([
      { action: 'select_date', value: '2026-08-20' },
      { action: 'select_date', value: '2026-08-21' },
      { action: 'select_date', value: '2026-08-22' },
      { action: 'select_date', value: '2026-08-24' },
      { action: 'select_date', value: '2026-08-25' },
      { action: 'choose_date', value: undefined },
    ]);
  });

  it('builds known visitor and email options from backend context', () => {
    const visitorContext = {
      name: 'Nguyen Huu Hem',
      email: 'visitor@example.com',
    };

    expect(
      buildChatMessageComponents(
        '<booking-step>name</booking-step>',
        siteContext,
        visitorContext,
      )[0].items,
    ).toEqual([
      {
        action: 'submit_text',
        value: 'Nguyen Huu Hem',
        label: 'Nguyen Huu Hem',
      },
    ]);
    expect(
      buildChatMessageComponents(
        '<booking-step>email</booking-step>',
        siteContext,
        visitorContext,
      )[0].items,
    ).toEqual([
      {
        action: 'submit_text',
        value: 'visitor@example.com',
        label: 'visitor@example.com',
      },
      { action: 'skip_email', labelKey: 'chip.skip' },
    ]);
  });

  it('does not create options without a backend-supported step', () => {
    expect(
      buildChatMessageComponents(
        '<chips>Book an appointment|Ask a question</chips>',
        siteContext,
      ),
    ).toEqual([]);
  });

  it('parses a structured widget selection', () => {
    expect(
      parseBookingOptionSelection(
        '/select-booking-option {"action":"select_service","value":"service-1","label":"goi dau","locale":"ja"} :: goi dau',
      ),
    ).toEqual({
      action: 'select_service',
      value: 'service-1',
      label: 'goi dau',
      locale: 'ja',
    });
  });

  it('routes free-text and skip actions through the booking model', () => {
    expect(
      bookingOptionNeedsModel({
        action: 'submit_text',
        value: 'Nguyen Huu Hem',
      }),
    ).toBe(true);
    expect(bookingOptionNeedsModel({ action: 'skip_email' })).toBe(true);
    expect(bookingOptionNeedsModel({ action: 'select_service' })).toBe(false);
  });

  it('extracts booking JSON without the visitor-facing command label', () => {
    expect(
      extractBookingCommandJson(
        '/update-draft-booking {"customerName":"Nguyen Huu Hem"} :: Lưu thay đổi',
        'update-draft-booking',
      ),
    ).toBe('{"customerName":"Nguyen Huu Hem"}');
    expect(
      extractBookingCommandJson(
        '/confirm-booking {"phone":"0912345678"} :: Confirm booking',
        'confirm-booking',
      ),
    ).toBe('{"phone":"0912345678"}');
  });

  it('ignores structured progress from an abandoned booking', () => {
    const messages = [
      {
        role: 'user' as const,
        content:
          '/select-booking-option {"action":"select_service","value":"service-1"} :: Service',
      },
      {
        role: 'user' as const,
        content: '/abandon-booking {"locale":"en"} :: Cancel',
      },
      { role: 'user' as const, content: 'I want to book again' },
    ];

    expect(hasActiveStructuredBookingProgress(messages, null)).toBe(false);
    expect(hasActiveStructuredBookingProgress(messages, 'BOOKING')).toBe(true);
  });
});
