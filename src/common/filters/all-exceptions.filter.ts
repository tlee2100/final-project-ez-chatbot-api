import {
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
  ExceptionFilter,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorEnvelope {
  statusCode: number;
  message: string | string[];
  ref: string;
  [key: string]: unknown;
}

/**
 * Global exception filter that:
 * 1. Prevents information disclosure (no raw stack traces or DB details to clients)
 * 2. Assigns a unique `ref` correlation ID to every error for log tracing
 * 3. Segregates log levels: ERROR for 5xx, WARN for 4xx
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // Unique reference ID for cross-referencing logs ↔ client error reports
    const ref = `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    if (status >= 500) {
      this.logger.error(
        `[${ref}] ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${ref}] ${request.method} ${request.url} → ${status}`);
    }

    const exceptionResponse = isHttp
      ? (exception.getResponse() as string | ErrorEnvelope)
      : 'Internal server error';

    const payload: ErrorEnvelope =
      typeof exceptionResponse === 'string'
        ? { statusCode: status, message: exceptionResponse, ref }
        : {
            ...exceptionResponse,
            statusCode: status,
            ref,
          };

    response.status(status).json(payload);
  }
}
