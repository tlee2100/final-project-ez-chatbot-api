import { Request } from 'express';
import { JwtUser } from './jwt-user.type';

export type AuthRequest = Request & {
  user: JwtUser;
};
