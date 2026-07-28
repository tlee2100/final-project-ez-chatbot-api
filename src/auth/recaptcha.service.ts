import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';

type RecaptchaVerifyResponse = {
  success: boolean;
  score?: number;
  action?: string;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
};

@Injectable()
export class RecaptchaService {
  async verify(token: string): Promise<void> {
    const secret = process.env.RECAPTCHA_SECRET_KEY;

    if (!secret) {
      throw new BadRequestException('Missing RECAPTCHA_SECRET_KEY');
    }

    if (!token) {
      throw new BadRequestException('Recaptcha token is required');
    }

    const params = new URLSearchParams({
      secret,
      response: token,
    });

    const response = await axios.post<RecaptchaVerifyResponse>(
      'https://www.google.com/recaptcha/api/siteverify',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    const data = response.data;

    if (!data.success) {
      throw new BadRequestException('reCAPTCHA verification failed');
    }

    if (data.action !== 'login') {
      throw new BadRequestException('Invalid reCAPTCHA action');
    }

    if (typeof data.score === 'number' && data.score < 0.5) {
      throw new BadRequestException('Low reCAPTCHA score');
    }
  }
}
