/** Maximum allowed file size for document uploads: 10 MB */
export const DOCUMENT_MAX_FILE_SIZE = 10 * 1024 * 1024;

export const DOCUMENT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
