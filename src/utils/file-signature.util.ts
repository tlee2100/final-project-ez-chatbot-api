import { BadRequestException } from '@nestjs/common';

/**
 * Checks if the buffer starts with the magic numbers of allowed image formats.
 * Supported formats: JPEG, PNG, GIF, WebP
 */
export function validateImageSignature(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return true;
  }

  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return true;
  }

  // WebP: RIFF .... WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }

  return false;
}

export function validateAndGetImageFile(
  file: Express.Multer.File,
): Express.Multer.File {
  if (!file) {
    throw new BadRequestException('No file provided');
  }

  if (!file.mimetype.startsWith('image/')) {
    throw new BadRequestException(
      'Invalid file type. Only images are allowed.',
    );
  }

  if (!validateImageSignature(file.buffer)) {
    throw new BadRequestException(
      'Invalid file signature. File might be corrupted or spoofed.',
    );
  }

  return file;
}
