import { EmailProcessor } from './email.processor';

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
    const mailerService = { sendMail: jest.fn().mockResolvedValue(undefined) };
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
});
