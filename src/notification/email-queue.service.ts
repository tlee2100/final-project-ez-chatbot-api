import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue, JobOptions } from 'bull';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import { INVITATION_ENCRYPTION_PURPOSE } from './constants/email.constants';

export interface UserActivationEmailData {
  to: string;
  userName: string;
  email: string;
  activationToken: string;
  activationUrl: string;
  expiresAt: string;
}

export interface UserActivationEmailJobData {
  to: string;
  userName: string;
  email: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
  activationUrl: string;
  expiresAt: string;
}

export const DEFAULT_EMAIL_JOB_OPTIONS: JobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 3000,
  },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

@Injectable()
export class EmailQueueService {
  constructor(
    @InjectQueue('email-queue')
    private readonly emailQueue: Queue,
  ) {}

  enqueueUserActivationEmail(
    data: UserActivationEmailData,
    opts?: JobOptions,
  ): Promise<unknown> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encryptedToken = Buffer.concat([
      cipher.update(data.activationToken, 'utf8'),
      cipher.final(),
    ]);

    const jobData: UserActivationEmailJobData = {
      to: data.to,
      userName: data.userName,
      email: data.email,
      encryptedToken: encryptedToken.toString('base64url'),
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
      activationUrl: data.activationUrl,
      expiresAt: data.expiresAt,
    };

    return this.emailQueue.add('send-user-activation', jobData, {
      ...DEFAULT_EMAIL_JOB_OPTIONS,
      ...opts,
    });
  }

  decryptActivationToken(job: UserActivationEmailJobData): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.getEncryptionKey(),
      Buffer.from(job.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(job.authTag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(job.encryptedToken, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  getEncryptionKey(): Buffer {
    const secret =
      process.env.EMAIL_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        'Missing EMAIL_TOKEN_ENCRYPTION_KEY or JWT_SECRET environment variable',
      );
    }

    return createHash('sha256')
      .update(`${secret}:${INVITATION_ENCRYPTION_PURPOSE}`)
      .digest();
  }
}
