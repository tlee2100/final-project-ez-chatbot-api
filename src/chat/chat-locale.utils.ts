export const DEFAULT_LOCALE = 'en';
export const UNDETERMINED_LOCALE = 'und';

export const normalizeLocale = (
  locale: string | null | undefined,
  fallback = UNDETERMINED_LOCALE,
): string => {
  const candidate = locale?.trim().replace(/_/g, '-');
  if (!candidate || candidate.toLowerCase() === UNDETERMINED_LOCALE) {
    return fallback;
  }

  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? fallback;
  } catch {
    return fallback;
  }
};

export const resolveEffectiveLocale = ({
  activeFlowLocale,
  detectedLocale,
  currentLocale,
}: {
  activeFlowLocale?: string | null;
  detectedLocale?: string | null;
  currentLocale?: string | null;
}): string => {
  for (const locale of [activeFlowLocale, detectedLocale, currentLocale]) {
    const normalized = normalizeLocale(locale);
    if (normalized !== UNDETERMINED_LOCALE) return normalized;
  }

  return DEFAULT_LOCALE;
};

export const localeLanguage = (locale: string): string =>
  new Intl.Locale(normalizeLocale(locale, DEFAULT_LOCALE)).language;

export const localeDisplayName = (locale: string): string => {
  const normalized = normalizeLocale(locale, DEFAULT_LOCALE);
  return (
    new Intl.DisplayNames(['en'], { type: 'language' }).of(normalized) ??
    normalized
  );
};
