import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { NotificationService } from 'src/notification/notification.service';
import { NotificationType } from 'src/notification/enums/notification-type.enum';

@Catch()
export class DocumentUploadExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DocumentUploadExceptionFilter.name);

  constructor(private readonly notificationService: NotificationService) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { user: { id: string } }>();
    const siteId = request.params.siteId as string;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorMessage = 'An unexpected error occurred during upload';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      const rawMessage =
        typeof res === 'object' && res !== null && 'message' in res
          ? (res as { message: string | string[] }).message
          : exception.message;
      errorMessage = Array.isArray(rawMessage)
        ? rawMessage.join(', ')
        : rawMessage;
    } else if (exception instanceof Error) {
      errorMessage = exception.message;
    }

    const userId = request.user?.id;
    // Try to get filename from multer if it was populated before throwing
    const fileName =
      (request as Request & { file?: { originalname: string } }).file
        ?.originalname || 'Unknown File';

    this.logger.error(
      `Document upload failed for site ${siteId}, user ${userId}: ${errorMessage}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    if (userId && siteId) {
      try {
        await this.notificationService.create({
          recipientId: userId,
          siteId: siteId,
          type: NotificationType.SYSTEM,
          title: 'Document Upload Failed',
          message: `Failed to upload document '${fileName}': ${errorMessage}`,
        });
      } catch (notifErr) {
        this.logger.error(
          `Failed to create notification for document upload error: ${notifErr instanceof Error ? notifErr.message : String(notifErr)}`,
        );
      }
    }

    response.status(status).json({
      statusCode: status,
      message: errorMessage,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
