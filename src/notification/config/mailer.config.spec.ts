import { getMailerConfig } from './mailer.config';

describe('getMailerConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MAIL_HOST: 'smtp.example.com',
      MAIL_PORT: '587',
      MAIL_FROMADDRESS: 'internship@zodinet.com',
      MAIL_FROMNAME: 'Internship',
      MAIL_USERNAME: 'smtp-user',
      MAIL_PASSWORD: 'smtp-password',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('builds the sender and STARTTLS transport from the supported variables', () => {
    const config = getMailerConfig();

    expect((config.defaults as { from?: string }).from).toBe(
      '"Internship" <internship@zodinet.com>',
    );
    expect(config.transport).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'smtp-user', pass: 'smtp-password' },
    });
  });

  it('fails when SMTP credentials are missing', () => {
    delete process.env.MAIL_USERNAME;

    expect(() => getMailerConfig()).toThrow(
      'Missing SMTP credentials. Please set MAIL_USERNAME and MAIL_PASSWORD in your .env',
    );
  });
});
