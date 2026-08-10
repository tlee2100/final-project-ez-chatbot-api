import {
  EmailQueueService,
  DEFAULT_EMAIL_JOB_OPTIONS,
  type UserActivationEmailJobData,
} from './email-queue.service';

describe('EmailQueueService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_SECRET: 'test-jwt-secret-key-12345',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('enqueues user activation email with AES-256-GCM encryption and default retry/cleanup options', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-activation-1' }),
    };
    const service = new EmailQueueService(queue as never);

    const emailData = {
      to: 'newuser@example.com',
      userName: 'New User',
      email: 'newuser@example.com',
      activationToken: 'raw-secret-activation-token-value',
      activationUrl: 'http://localhost:3001/set-password',
      expiresAt: '2026-08-07T00:00:00.000Z',
    };

    await service.enqueueUserActivationEmail(emailData);

    expect(queue.add).toHaveBeenCalledTimes(1);
    const [jobName, jobData, jobOptions] = queue.add.mock.calls[0] as [
      string,
      UserActivationEmailJobData,
      typeof DEFAULT_EMAIL_JOB_OPTIONS,
    ];

    expect(jobName).toBe('send-user-activation');
    expect(jobData.to).toBe(emailData.to);
    expect(jobData.userName).toBe(emailData.userName);
    expect(jobData.email).toBe(emailData.email);
    expect(jobData.encryptedToken).toBeDefined();
    expect(jobData.encryptedToken).not.toBe(emailData.activationToken);
    expect(jobData.iv).toBeDefined();
    expect(jobData.authTag).toBeDefined();

    // Verify job retry & cleanup options
    expect(jobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });

    // Verify decryption roundtrip
    const decrypted = service.decryptActivationToken(jobData);
    expect(decrypted).toBe(emailData.activationToken);
  });

  it('prefers EMAIL_TOKEN_ENCRYPTION_KEY over JWT_SECRET when provided', () => {
    process.env.EMAIL_TOKEN_ENCRYPTION_KEY =
      'dedicated-email-encryption-secret';
    process.env.JWT_SECRET = 'different-jwt-secret';

    const queue = { add: jest.fn() };
    const service = new EmailQueueService(queue as never);

    const key1 = service.getEncryptionKey();

    delete process.env.EMAIL_TOKEN_ENCRYPTION_KEY;
    const key2 = service.getEncryptionKey();

    expect(key1).not.toEqual(key2);
  });

  it('fails decryption when auth tag or encrypted payload is tampered', () => {
    const queue = { add: jest.fn() };
    const service = new EmailQueueService(queue as never);

    const tamperedJobData: UserActivationEmailJobData = {
      to: 'user@example.com',
      userName: 'User',
      email: 'user@example.com',
      encryptedToken: Buffer.from('invalid-encrypted-token').toString(
        'base64url',
      ),
      iv: Buffer.from('123456789012').toString('base64url'),
      authTag: Buffer.from('1234567890123456').toString('base64url'),
      activationUrl: 'http://localhost:3001/set-password',
      expiresAt: '2026-08-07T00:00:00.000Z',
    };

    expect(() => service.decryptActivationToken(tamperedJobData)).toThrow();
  });
});
