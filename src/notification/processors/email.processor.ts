import {
  OnQueueCompleted,
  OnQueueError,
  OnQueueFailed,
  Process,
  Processor,
} from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { MailerService } from '@nestjs-modules/mailer';
import QRCode from 'qrcode';
import { marked } from 'marked';
import {
  EmailQueueService,
  type PasswordChangedEmailJobData,
  type UserActivationEmailJobData,
  type BookingConfirmationEmailJobData,
  type BookingCancellationEmailJobData,
  type ConversationSummaryEmailJobData,
  type ChatTranscriptEmailJobData,
} from '../email-queue.service';
import {
  EMAIL_TIME_ZONE,
  EMAIL_TIME_ZONE_LABEL,
} from '../constants/email.constants';

const emailDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: EMAIL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const formatEmailDateTime = (value: string): string =>
  `${emailDateTimeFormatter.format(new Date(value))} (${EMAIL_TIME_ZONE_LABEL})`;

@Processor('email-queue')
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    private readonly mailerService: MailerService,
    private readonly emailQueueService: EmailQueueService,
  ) {}

  @Process('send-user-activation')
  async handleSendUserActivation(job: Job<UserActivationEmailJobData>) {
    this.logger.log(
      `Processing send-user-activation job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      const token = this.emailQueueService.decryptActivationToken(job.data);
      const activationUrl = `${job.data.activationUrl}?token=${encodeURIComponent(token)}`;
      const qrDataUrl = await QRCode.toDataURL(activationUrl);
      const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');

      const result: unknown = await this.mailerService.sendMail({
        to: job.data.to,
        subject: '[ezChatBot] Activate your account',
        template: 'user-activation',
        context: {
          userName: job.data.userName,
          email: job.data.email,
          activationUrl,
          expiresAt: formatEmailDateTime(job.data.expiresAt),
        },
        attachments: [
          {
            filename: 'activation-qr.png',
            content: qrBase64,
            encoding: 'base64',
            cid: 'activation-qr',
          },
        ],
      });
      this.logger.log(
        `User activation email successfully sent to ${job.data.to}, result: ${JSON.stringify(result)}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send user activation email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @Process('send-password-changed')
  async handleSendPasswordChanged(job: Job<PasswordChangedEmailJobData>) {
    this.logger.log(
      `Processing send-password-changed job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      await this.mailerService.sendMail({
        to: job.data.to,
        subject: '[ezChatBot] Your password was changed',
        template: 'password-changed',
        context: {
          userName: job.data.userName,
          changedAt: formatEmailDateTime(job.data.changedAt),
        },
      });
      this.logger.log(
        `Password changed email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send password changed email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @Process('send-booking-confirmation')
  async handleBookingConfirmation(job: Job<BookingConfirmationEmailJobData>) {
    this.logger.log(
      `Processing send-booking-confirmation job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: job.data.timezone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const startAtFormatted = formatter.format(new Date(job.data.startAt));
      const endAtFormatted = formatter.format(new Date(job.data.endAt));

      await this.mailerService.sendMail({
        to: job.data.to,
        subject: `Booking Confirmed – #${job.data.bookingCode}`,
        template: 'booking-confirmation',
        context: {
          ...job.data,
          startAtFormatted,
          endAtFormatted,
        },
      });
      this.logger.log(
        `Booking confirmation email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send booking confirmation email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @Process('send-booking-cancellation')
  async handleBookingCancellation(job: Job<BookingCancellationEmailJobData>) {
    this.logger.log(
      `Processing send-booking-cancellation job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: job.data.timezone || 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
      const startAtFormatted = formatter.format(new Date(job.data.startAt));

      await this.mailerService.sendMail({
        to: job.data.to,
        subject: `Booking Cancelled – #${job.data.bookingCode}`,
        template: 'booking-cancellation',
        context: {
          ...job.data,
          startAtFormatted,
        },
      });
      this.logger.log(
        `Booking cancellation email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send booking cancellation email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @Process('send-conversation-summary')
  async handleConversationSummary(job: Job<ConversationSummaryEmailJobData>) {
    this.logger.log(
      `Processing send-conversation-summary job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      await this.mailerService.sendMail({
        to: job.data.to,
        subject: `Conversation Summary – ${job.data.siteName}`,
        template: 'conversation-summary',
        context: {
          ...job.data,
          visitorName: job.data.visitorName || 'Unknown Visitor',
          visitorEmail: job.data.visitorEmail || 'Not provided',
          startedAt: new Date(job.data.startedAt).toLocaleString(),
          closedAt: new Date(job.data.closedAt).toLocaleString(),
          summaryHtml: marked.parse(job.data.summaryText, { async: false }),
        },
      });
      this.logger.log(
        `Conversation summary email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send conversation summary email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @Process('send-chat-transcript')
  async handleChatTranscript(job: Job<ChatTranscriptEmailJobData>) {
    this.logger.log(
      `Processing send-chat-transcript job #${job.id} (attempt ${job.attemptsMade + 1}/${job.opts.attempts || 1}) to ${job.data.to}`,
    );
    try {
      const messagesWithHtml = job.data.messages.map((m) => ({
        ...m,
        content: marked.parse(m.content, { async: false }),
      }));

      await this.mailerService.sendMail({
        to: job.data.to,
        subject: `Your chat transcript – ${job.data.siteName}`,
        template: 'chat-transcript',
        context: {
          ...job.data,
          messages: messagesWithHtml,
          // startedAt and closedAt are already formatted local-time strings
          // produced by ChatService.formatForEmail() — do NOT re-parse them.
          timezone: job.data.timezone ?? 'UTC',
        },
      });
      this.logger.log(
        `Chat transcript email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send chat transcript email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  @OnQueueCompleted()
  onCompleted(job: Job) {
    this.logger.debug(
      `Job #${job.id} of type ${job.name} has completed successfully.`,
    );
  }

  @OnQueueFailed()
  onFailed(job: Job, error: Error) {
    this.logger.error(
      `Job #${job.id} of type ${job.name} failed after attempt ${job.attemptsMade}: ${error.message}`,
    );
  }

  @OnQueueError()
  onError(error: Error) {
    this.logger.error(`Bull queue error encountered: ${error.message}`);
  }
}
