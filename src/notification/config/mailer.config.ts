import { MailerOptions } from '@nestjs-modules/mailer';
import { HandlebarsAdapter } from '@nestjs-modules/mailer/adapters/handlebars.adapter';
import { join } from 'path';

/** Generates the SMTP mailer configuration from the supported environment variables. */
export const getMailerConfig = (): MailerOptions => {
  const host =
    process.env.MAIL_HOST || 'email-smtp.ap-southeast-1.amazonaws.com';
  const port = parseInt(process.env.MAIL_PORT || '587', 10);
  const secure = port === 465;

  const user = process.env.MAIL_USERNAME;
  const pass = process.env.MAIL_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      'Missing SMTP credentials. Please set MAIL_USERNAME and MAIL_PASSWORD in your .env',
    );
  }

  const fromAddress = process.env.MAIL_FROMADDRESS || 'internship@zodinet.com';
  const fromName = process.env.MAIL_FROMNAME || 'Internship';
  const from = `"${fromName}" <${fromAddress}>`;

  return {
    transport: {
      host,
      port,
      secure,
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: { user, pass },
    },
    defaults: {
      from,
    },
    template: {
      dir: join(__dirname, '..', 'templates'),
      adapter: new HandlebarsAdapter(),
      options: {
        strict: true,
      },
    },
  };
};
