import { BadRequestException } from '@nestjs/common';
import { createRequire } from 'node:module';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth/lib/index';
import type sanitizeHtml from 'sanitize-html';
import {
  DocumentFileType,
  EXTENSION_TO_FILE_TYPE,
} from '../enums/document-file-type.enum';
import {
  DOCUMENT_ALLOWED_MIME_TYPES,
  DOCUMENT_MAX_FILE_SIZE,
} from '../constants/document-upload.constants';

type SanitizeHtml = typeof sanitizeHtml;

const requireModule = createRequire(__filename);

export interface DocumentValidationResult {
  isValid: boolean;
  fileType: DocumentFileType;
  sanitizedContent?: string;
  errorMessage?: string;
}

export class DocumentContextValidator {
  /**
   * Fast synchronous validation for file header & extension (Multer FileFilter)
   */
  static validateHeaderAndExtension(file?: Express.Multer.File): void {
    if (!file) {
      throw new BadRequestException('File is required');
    }

    if (file.size > DOCUMENT_MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File size exceeds limit of ${DOCUMENT_MAX_FILE_SIZE / (1024 * 1024)}MB`,
      );
    }

    const fileType = this.resolveFileType(file.originalname);
    if (!fileType) {
      const ext = file.originalname.split('.').pop()?.toLowerCase() ?? '';
      throw new BadRequestException(
        `Unsupported file extension '.${ext}'. Allowed extensions: pdf, txt, md, html, docx`,
      );
    }

    if (file.mimetype && !DOCUMENT_ALLOWED_MIME_TYPES.has(file.mimetype)) {
      // Allow fallback if mime type is generic application/octet-stream but extension is valid
      if (file.mimetype !== 'application/octet-stream') {
        throw new BadRequestException(
          `Invalid MIME type '${file.mimetype}'. Only PDF, TXT, MD, HTML, and DOCX are allowed`,
        );
      }
    }

    if (file.buffer) {
      this.validateMagicBytes(file.buffer, fileType);
    }
  }

  /**
   * Full asynchronous context & content validation (Deep inspection)
   */
  static async validateAndExtractContent(
    buffer: Buffer,
    filename: string,
  ): Promise<DocumentValidationResult> {
    const fileType = this.resolveFileType(filename);

    if (!fileType) {
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      throw new BadRequestException(`Unsupported file extension: ${ext}`);
    }

    this.validateMagicBytes(buffer, fileType);

    try {
      switch (fileType) {
        case DocumentFileType.PDF:
          return await this.validatePdf(buffer);
        case DocumentFileType.DOCX:
          return await this.validateDocx(buffer);
        case DocumentFileType.HTML:
          return this.validateHtml(buffer);
        case DocumentFileType.TXT:
        case DocumentFileType.MARKDOWN:
          return this.validatePlainText(buffer, fileType);
        case DocumentFileType.URL:
        default:
          throw new BadRequestException(
            `Unsupported file validation type: ${fileType}`,
          );
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const msg =
        error instanceof Error ? error.message : 'Unknown validation error';
      throw new BadRequestException(`File context validation failed: ${msg}`);
    }
  }

  private static validateMagicBytes(
    buffer: Buffer,
    fileType: DocumentFileType,
  ): void {
    if (buffer.length < 4) {
      throw new BadRequestException('File buffer is too small or corrupted');
    }

    if (fileType === DocumentFileType.PDF) {
      // PDF magic bytes: %PDF- (0x25 0x50 0x44 0x46)
      const isPdfHeader =
        buffer[0] === 0x25 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x44 &&
        buffer[3] === 0x46;
      if (!isPdfHeader) {
        throw new BadRequestException(
          'File content header does not match a valid PDF signature (Magic bytes check failed)',
        );
      }
    } else if (fileType === DocumentFileType.DOCX) {
      // DOCX (Zip archive) magic bytes: PK\x03\x04 (0x50 0x4B 0x03 0x04)
      const isDocxHeader =
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;
      if (!isDocxHeader) {
        throw new BadRequestException(
          'File content header does not match a valid DOCX signature (Magic bytes check failed)',
        );
      }
    } else if (
      fileType === DocumentFileType.TXT ||
      fileType === DocumentFileType.MARKDOWN
    ) {
      // Check for common image magic bytes (PNG, JPEG, GIF, WEBP) disguised as txt/md
      const isPng =
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47;
      const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
      const isGif =
        buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
      const isWebp =
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46;

      if (isPng || isJpeg || isGif || isWebp) {
        throw new BadRequestException(
          'Image files are not allowed, even if renamed with a .txt extension',
        );
      }

      const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
      if (sample.includes(0)) {
        throw new BadRequestException(
          'Text file contains binary characters and is not valid UTF-8 plain text',
        );
      }
    }
  }

  private static async validatePdf(
    buffer: Buffer,
  ): Promise<DocumentValidationResult> {
    const parser = new PDFParse({ data: buffer });

    try {
      const data = await parser.getText();
      const text = data.text.trim();

      if (!text && data.total === 0) {
        throw new BadRequestException('PDF file is empty or corrupted');
      }

      return {
        isValid: true,
        fileType: DocumentFileType.PDF,
        sanitizedContent: text,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to parse PDF document. File may be encrypted or corrupted: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await parser.destroy();
    }
  }

  private static async validateDocx(
    buffer: Buffer,
  ): Promise<DocumentValidationResult> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value ? result.value.trim() : '';

      return {
        isValid: true,
        fileType: DocumentFileType.DOCX,
        sanitizedContent: text,
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to parse DOCX document. File may be damaged or invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private static validateHtml(buffer: Buffer): DocumentValidationResult {
    const rawContent = buffer.toString('utf-8');

    if (!rawContent.trim()) {
      throw new BadRequestException('HTML file is empty');
    }

    const cleanContent = this.sanitizeHtmlContent(rawContent);

    return {
      isValid: true,
      fileType: DocumentFileType.HTML,
      sanitizedContent: cleanContent,
    };
  }

  private static sanitizeHtmlContent(rawContent: string): string {
    let clean = rawContent;
    // 1. Remove <script> tags and content
    clean = clean.replace(
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
      '',
    );
    // 2. Remove <style> tags and content
    clean = clean.replace(
      /<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi,
      '',
    );
    // 3. Remove <iframe> tags and content
    clean = clean.replace(
      /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
      '',
    );
    // 4. Remove inline event handlers like onload, onerror, onclick
    clean = clean.replace(/\s+on\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, '');
    // 5. Remove javascript: links
    clean = clean.replace(
      /href\s*=\s*(?:['"]\s*javascript:[^'"]*['"]|[^\s>]+)/gi,
      '',
    );

    const htmlSanitizer = this.loadHtmlSanitizer();
    if (!htmlSanitizer) {
      return clean;
    }

    return htmlSanitizer(clean, {
      allowedTags: [
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'p',
        'a',
        'ul',
        'ol',
        'li',
        'b',
        'i',
        'strong',
        'em',
        'strike',
        'code',
        'hr',
        'br',
        'div',
        'span',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'blockquote',
      ],
      allowedAttributes: {
        a: ['href', 'title'],
      },
      disallowedTagsMode: 'discard',
    });
  }

  private static loadHtmlSanitizer(): SanitizeHtml | undefined {
    try {
      const loaded: unknown = requireModule('sanitize-html');
      return typeof loaded === 'function'
        ? (loaded as SanitizeHtml)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private static validatePlainText(
    buffer: Buffer,
    type: DocumentFileType.TXT | DocumentFileType.MARKDOWN,
  ): DocumentValidationResult {
    const text = buffer.toString('utf-8').trim();

    // Check for null characters or binary garbage
    if (text.includes('\u0000')) {
      throw new BadRequestException(
        `Text file contains binary characters and is not valid UTF-8 plain text`,
      );
    }

    return {
      isValid: true,
      fileType: type,
      sanitizedContent: text,
    };
  }

  /**
   * Resolves a filename's extension to its canonical DocumentFileType.
   * Returns undefined if the extension is not supported.
   */
  private static resolveFileType(
    filename: string,
  ): DocumentFileType | undefined {
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_TO_FILE_TYPE.get(ext);
  }
}
