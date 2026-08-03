import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { memoryStorage } from 'multer';
import { DocumentContextValidator } from './validators/document-context.validator';
import { DOCUMENT_MAX_FILE_SIZE } from './constants/document-upload.constants';

export const documentUploadOptions: MulterOptions = {
  storage: memoryStorage(),
  fileFilter: (_req, file, cb) => {
    try {
      DocumentContextValidator.validateHeaderAndExtension(
        file as Express.Multer.File,
      );
      cb(null, true);
    } catch (error) {
      cb(error as Error, false);
    }
  },
  limits: {
    fileSize: DOCUMENT_MAX_FILE_SIZE,
  },
};
