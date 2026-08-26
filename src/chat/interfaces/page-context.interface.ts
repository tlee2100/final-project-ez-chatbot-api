export interface SanitizedPageContext {
  pageUrl: string;
  pageTitle?: string;
  pageContent?: string;
}

export interface RawPageContext {
  pageUrl?: unknown;
  pageTitle?: unknown;
  pageContent?: unknown;
}

export type PageContextReason =
  | 'accepted'
  | 'not_provided'
  | 'disabled_by_site'
  | 'invalid_shape'
  | 'missing_url'
  | 'field_too_large'
  | 'invalid_url'
  | 'url_credentials_not_allowed'
  | 'domain_not_allowed';

export interface PageContextSanitizationResult {
  context?: SanitizedPageContext;
  reason: PageContextReason;
  hostname?: string;
  contentLength: number;
}
