import { ForbiddenException } from '@nestjs/common';

jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import {
  createMapperMock,
  createRepositoryMock,
} from '../test/service-test-helpers';
import { UserGender } from './entities/user.entity';
import { UserRole } from './enums/user-role.enum';
import { UserService } from './user.service';

describe('UserService access rules', () => {
  it('blocks admin from creating another admin', async () => {
    const repository = createRepositoryMock();
    const service = new UserService(
      repository as never,
      createMapperMock() as never,
    );

    await expect(
      service.create(
        {
          email: 'admin@example.com',
          name: 'Admin',
          role: UserRole.ADMIN,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
          gender: UserGender.OTHER,
        },
        {
          id: 'user-1',
          email: 'owner@example.com',
          role: UserRole.ADMIN,
          organizationId: '550e8400-e29b-41d4-a716-446655440000',
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
