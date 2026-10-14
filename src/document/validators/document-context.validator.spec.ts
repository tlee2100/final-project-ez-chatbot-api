import { BadRequestException } from '@nestjs/common';
import { DocumentContextValidator } from './document-context.validator';

describe('DocumentContextValidator', () => {
  describe('validateHeaderAndExtension', () => {
    it('should throw BadRequestException if file is missing', () => {
      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(),
      ).toThrow(BadRequestException);
    });

    it('should throw BadRequestException if extension is disallowed', () => {
      const mockFile = {
        originalname: 'script.exe',
        size: 1024,
        mimetype: 'application/x-msdownload',
        buffer: Buffer.from('MZ...'),
      } as Express.Multer.File;

      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(mockFile),
      ).toThrow(BadRequestException);
    });

    it('should throw BadRequestException if PDF magic bytes do not match', () => {
      const fakePdf = {
        originalname: 'fake.pdf',
        size: 1024,
        mimetype: 'application/pdf',
        buffer: Buffer.from('NOT_A_PDF_HEADER'),
      } as Express.Multer.File;

      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(fakePdf),
      ).toThrow(BadRequestException);
    });

    it('should pass if PDF magic bytes match %PDF-', () => {
      const validPdfBuffer = Buffer.concat([
        Buffer.from([0x25, 0x50, 0x44, 0x46]), // %PDF-
        Buffer.from('-1.4 content'),
      ]);
      const validPdf = {
        originalname: 'valid.pdf',
        size: 1024,
        mimetype: 'application/pdf',
        buffer: validPdfBuffer,
      } as Express.Multer.File;

      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(validPdf),
      ).not.toThrow();
    });

    it('should pass if DOCX magic bytes match PK\\x03\\x04', () => {
      const validDocxBuffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
      const validDocx = {
        originalname: 'sample.docx',
        size: 1024,
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: validDocxBuffer,
      } as Express.Multer.File;

      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(validDocx),
      ).not.toThrow();
    });

    it('should throw BadRequestException if an image file is renamed to .txt', () => {
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      const fakeTxt = {
        originalname: 'image_disguised.txt',
        size: 1024,
        mimetype: 'text/plain',
        buffer: pngBuffer,
      } as Express.Multer.File;

      expect(() =>
        DocumentContextValidator.validateHeaderAndExtension(fakeTxt),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateAndExtractContent (HTML Sanitization)', () => {
    it('should sanitize script and iframe tags from HTML content', async () => {
      const htmlBuffer = Buffer.from(
        '<html><body><h1>Title</h1><script>alert("hack")</script><iframe src="malicious.html"></iframe><p>Hello world</p></body></html>',
      );

      const result = await DocumentContextValidator.validateAndExtractContent(
        htmlBuffer,
        'index.html',
      );

      expect(result.isValid).toBe(true);
      expect(result.fileType).toBe('html');
      expect(result.sanitizedContent).not.toContain('<script>');
      expect(result.sanitizedContent).not.toContain('<iframe>');
      expect(result.sanitizedContent).toContain('<h1>Title</h1>');
      expect(result.sanitizedContent).toContain('<p>Hello world</p>');
    });

    it('should extract plain text content correctly', async () => {
      const textBuffer = Buffer.from('Plain text content for KB');

      const result = await DocumentContextValidator.validateAndExtractContent(
        textBuffer,
        'doc.txt',
      );

      expect(result.isValid).toBe(true);
      expect(result.fileType).toBe('txt');
      expect(result.sanitizedContent).toBe('Plain text content for KB');
    });
  });
});
