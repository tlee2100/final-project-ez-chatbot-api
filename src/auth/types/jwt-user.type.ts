import { UserRole } from 'src/user/enums/user-role.enum';

export type JwtUser = {
  id: string;
  email: string;
  role: UserRole;
};
