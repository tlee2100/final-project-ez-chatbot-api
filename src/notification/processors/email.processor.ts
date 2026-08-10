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
import {
  EmailQueueService,
  type UserActivationEmailJobData,
} from '../email-queue.service';

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

      await this.mailerService.sendMail({
        to: job.data.to,
        subject: '[ezChatBot] Activate your account',
        template: 'user-activation',
        context: {
          userName: job.data.userName,
          email: job.data.email,
          activationUrl,
          expiresAt: new Date(job.data.expiresAt).toLocaleString(),
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
        `User activation email successfully sent to ${job.data.to}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send user activation email to ${job.data.to} (job #${job.id}): ${(error as Error).message}`,
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
