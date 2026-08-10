export type InvalidSearchInputCode =
  | 'INVALID_SITE_ID'
  | 'EMPTY_QUERY'
  | 'INVALID_TOP_K'
  | 'INVALID_MIN_SIMILARITY';

export class InvalidSearchInputError extends Error {
  constructor(
    public readonly code: InvalidSearchInputCode,
    message: string,
  ) {
    super(message);
    this.name = InvalidSearchInputError.name;
  }
}
