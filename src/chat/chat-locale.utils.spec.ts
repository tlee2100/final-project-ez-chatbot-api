import {
  DEFAULT_LOCALE,
  localeDisplayName,
  normalizeLocale,
  resolveEffectiveLocale,
} from './chat-locale.utils';

describe('chat locale utilities', () => {
  it('normalizes valid BCP 47 locale tags', () => {
    expect(normalizeLocale('pt_br')).toBe('pt-BR');
    expect(normalizeLocale('ZH-hant')).toBe('zh-Hant');
    expect(normalizeLocale('not a locale')).toBe('und');
  });

  it('provides an explicit language name for model instructions', () => {
    expect(localeDisplayName('en')).toBe('English');
    expect(localeDisplayName('vi')).toBe('Vietnamese');
    expect(localeDisplayName('ja-JP')).toBe('Japanese (Japan)');
    expect(localeDisplayName('zh-CN')).toBe('Chinese (China)');
  });

  it('keeps an active flow locale locked', () => {
    expect(
      resolveEffectiveLocale({
        activeFlowLocale: 'en',
        detectedLocale: 'vi',
        currentLocale: 'ja',
      }),
    ).toBe('en');
  });

  it('uses the detected locale outside a flow and falls back safely', () => {
    expect(
      resolveEffectiveLocale({
        detectedLocale: 'ko',
        currentLocale: 'vi',
      }),
    ).toBe('ko');
    expect(resolveEffectiveLocale({ currentLocale: 'fr' })).toBe('fr');
    expect(resolveEffectiveLocale({})).toBe(DEFAULT_LOCALE);
  });
});
