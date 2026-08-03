export enum DocumentFileType {
  PDF = 'pdf',
  DOCX = 'docx',
  HTML = 'html',
  TXT = 'txt',
  MARKDOWN = 'md',
  URL = 'url',
}

/**
 * Maps all accepted file extensions (including aliases) to their canonical DocumentFileType.
 * Single source of truth for extension → type resolution.
 */
export const EXTENSION_TO_FILE_TYPE = new Map<string, DocumentFileType>([
  ['pdf', DocumentFileType.PDF],
  ['docx', DocumentFileType.DOCX],
  ['html', DocumentFileType.HTML],
  ['htm', DocumentFileType.HTML],
  ['txt', DocumentFileType.TXT],
  ['md', DocumentFileType.MARKDOWN],
  ['markdown', DocumentFileType.MARKDOWN],
]);
