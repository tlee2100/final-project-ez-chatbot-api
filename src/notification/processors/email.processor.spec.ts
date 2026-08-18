jest.mock('marked', () => ({
  marked: {
    parse: (text: string) => text,
  },
}));

import { EmailProcessor } from './email.processor';

interface SentMailOptions {
  context?: {
    expiresAt?: string;
  };
}

describe('EmailProcessor', () => {
  const jobData = {
    to: 'agent@example.com',
    userName: 'Agent',
    email: 'agent@example.com',
    encryptedToken: 'encrypted-token',
    iv: 'iv',
    authTag: 'auth-tag',
    activationUrl: 'http://localhost:3001/set-password',
    expiresAt: '2026-08-06T00:00:00.000Z',
  };

  it('sends an activation email with a QR code attachment', async () => {
    const sendMail = jest
      .fn<Promise<void>, [SentMailOptions]>()
      .mockResolvedValue(undefined);
    const mailerService = { sendMail };
    const emailQueueService = {
      decryptActivationToken: jest.fn().mockReturnValue('activation-token'),
    };
    const processor = new EmailProcessor(
      mailerService as never,
      emailQueueService as never,
    );

    await processor.handleSendUserActivation({
      id: 'job-1',
      data: jobData,
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    expect(mailerService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: jobData.to,
        subject: '[ezChatBot] Activate your account',
        template: 'user-activation',
      }),
    );
    const sentMail = sendMail.mock.calls[0]?.[0];
    expect(sentMail).toHaveProperty(
      'context.expiresAt',
      '06/08/2026, 07:00:00 (UTC+7)',
    );
  });

  it('rethrows mailer errors so Bull can retry the job', async () => {
    const error = new Error('SMTP unavailable');
    const mailerService = { sendMail: jest.fn().mockRejectedValue(error) };
    const emailQueueService = {
      decryptActivationToken: jest.fn().mockReturnValue('activation-token'),
    };
    const processor = new EmailProcessor(
      mailerService as never,
      emailQueueService as never,
    );

    await expect(
      processor.handleSendUserActivation({
        id: 'job-1',
        data: jobData,
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toBe(error);
  });

  it('sends a password changed security notification', async () => {
    const mailerService = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const emailQueueService = {
      decryptActivationToken: jest.fn(),
    };
    const processor = new EmailProcessor(
      mailerService as never,
      emailQueueService as never,
    );
    const changedAt = '2026-08-07T10:00:00.000Z';

    await processor.handleSendPasswordChanged({
      id: 'job-password-changed-1',
      data: {
        to: 'user@example.com',
        userName: 'User',
        changedAt,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    expect(mailerService.sendMail).toHaveBeenCalledWith({
      to: 'user@example.com',
      subject: '[ezChatBot] Your password was changed',
      template: 'password-changed',
      context: {
        userName: 'User',
        changedAt: '07/08/2026, 17:00:00 (UTC+7)',
      },
    });
  });

  it('rethrows password changed mailer errors so Bull can retry the job', async () => {
    const error = new Error('SMTP unavailable');
    const mailerService = { sendMail: jest.fn().mockRejectedValue(error) };
    const processor = new EmailProcessor(mailerService as never, {} as never);

    await expect(
      processor.handleSendPasswordChanged({
        id: 'job-password-changed-1',
        data: {
          to: 'user@example.com',
          userName: 'User',
          changedAt: '2026-08-07T10:00:00.000Z',
        },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toBe(error);
  });
});
