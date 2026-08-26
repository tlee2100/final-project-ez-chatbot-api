import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';

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
    const emailQueueService = {
      enqueueUserActivationEmail: jest.fn(),
    };
    const service = new UserService(
      repository as never,
      createMapperMock() as never,
      emailQueueService as never,
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

  it('hashes the password, queues credentials email, and does not expose the password', async () => {
    const repository = createRepositoryMock();
    const mapper = createMapperMock();
    const emailQueueService = {
      enqueueUserActivationEmail: jest.fn(),
    };
    const service = new UserService(
      repository as never,
      mapper as never,
      emailQueueService as never,
    );
    const savedUser = {
      id: 'user-1',
      email: 'agent@example.com',
      name: 'Agent',
      role: UserRole.AGENT,
      organizationId: '550e8400-e29b-41d4-a716-446655440000',
      gender: UserGender.OTHER,
      password: 'hashed-password',
    };
    let persistedPassword: string | undefined;
    repository.save.mockImplementation((entity: { password: string }) => {
      persistedPassword = entity.password;
      return Promise.resolve(savedUser);
    });
    let queuedPassword: string | undefined;
    let queuedLoginUrl: string | undefined;
    emailQueueService.enqueueUserActivationEmail.mockImplementation(
      (data: { activationToken: string; activationUrl: string }) => {
        queuedPassword = data.activationToken;
        queuedLoginUrl = data.activationUrl;
        return Promise.resolve({ id: 'job-1' });
      },
    );

    const result = await service.create(
      {
        email: savedUser.email,
        name: savedUser.name,
        role: savedUser.role,
        organizationId: savedUser.organizationId,
        gender: savedUser.gender,
      },
      {
        id: 'super-admin',
        email: 'super-admin@example.com',
        role: UserRole.SUPER_ADMIN,
        organizationId: null,
      },
    );

    expect(repository.save).toHaveBeenCalled();
    expect(emailQueueService.enqueueUserActivationEmail).toHaveBeenCalled();
    expect(persistedPassword).toEqual(expect.any(String));
    expect(queuedPassword).toEqual(expect.any(String));
    expect(queuedLoginUrl).toEqual(expect.stringContaining('/set-password'));
    expect(persistedPassword).not.toBe(queuedPassword);
    expect(result).toEqual({ user: savedUser, activationEmailQueued: true });
    expect(result).not.toHaveProperty('initialPassword');
  });

  it('deletes the temporary user record when credentials email cannot be queued', async () => {
    const repository = createRepositoryMock();
    const emailQueueService = {
      enqueueUserActivationEmail: jest
        .fn()
        .mockRejectedValue(new Error('Redis unavailable')),
    };
    const service = new UserService(
      repository as never,
      createMapperMock() as never,
      emailQueueService as never,
    );
    const savedUser = {
      id: 'user-1',
      email: 'agent@example.com',
      name: 'Agent',
      role: UserRole.AGENT,
      organizationId: '550e8400-e29b-41d4-a716-446655440000',
      gender: UserGender.OTHER,
      password: 'hashed-password',
    };
    repository.save.mockResolvedValue(savedUser);

    await expect(
      service.create(
        {
          email: savedUser.email,
          name: savedUser.name,
          role: savedUser.role,
          organizationId: savedUser.organizationId,
          gender: savedUser.gender,
        },
        {
          id: 'super-admin',
          email: 'super-admin@example.com',
          role: UserRole.SUPER_ADMIN,
          organizationId: null,
        },
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(repository.delete).toHaveBeenCalledWith(savedUser.id);
  });

  describe('resendActivation', () => {
    it('resends activation email successfully when cooldown has expired', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest
          .fn()
          .mockResolvedValue({ id: 'job-resend' }),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );

      const targetUser = {
        id: 'user-inactive',
        email: 'inactive@example.com',
        name: 'Inactive User',
        role: UserRole.AGENT,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        isActive: false,
        activationTokenHash: 'old-hash',
        activationTokenExpiresAt: new Date(Date.now() - 10000), // Expired
      };
      repository.findOne.mockResolvedValue(targetUser);
      repository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      const result = await service.resendActivation('user-inactive', {
        id: 'super-admin',
        email: 'super@example.com',
        role: UserRole.SUPER_ADMIN,
        organizationId: null,
      });

      expect(result).toEqual({ activationEmailQueued: true });
      expect(repository.save).toHaveBeenCalled();
      expect(emailQueueService.enqueueUserActivationEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'inactive@example.com',
          userName: 'Inactive User',
          email: 'inactive@example.com',
          activationToken: expect.any(String) as string,
          activationUrl: expect.stringContaining('/set-password') as string,
        }),
      );
      expect(result).toEqual({ activationEmailQueued: true });
    });

    it('rejects resendActivation if user is already active', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );

      const activeUser = {
        id: 'user-active',
        email: 'active@example.com',
        name: 'Active User',
        role: UserRole.AGENT,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        isActive: true,
      };
      repository.findOne.mockResolvedValue(activeUser);

      await expect(
        service.resendActivation('user-active', {
          id: 'super-admin',
          email: 'super@example.com',
          role: UserRole.SUPER_ADMIN,
          organizationId: null,
        }),
      ).rejects.toThrow('User account is already active');

      expect(
        emailQueueService.enqueueUserActivationEmail,
      ).not.toHaveBeenCalled();
    });

    it('rejects resendActivation when cooldown (60s) has not passed', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );

      // Token created 10 seconds ago (expires in 24h - 10s)
      const targetUser = {
        id: 'user-inactive',
        email: 'inactive@example.com',
        name: 'Inactive User',
        role: UserRole.AGENT,
        organizationId: '550e8400-e29b-41d4-a716-446655440000',
        isActive: false,
        activationTokenHash: 'recent-hash',
        activationTokenExpiresAt: new Date(
          Date.now() + 24 * 60 * 60 * 1000 - 10 * 1000,
        ),
      };
      repository.findOne.mockResolvedValue(targetUser);

      await expect(
        service.resendActivation('user-inactive', {
          id: 'super-admin',
          email: 'super@example.com',
          role: UserRole.SUPER_ADMIN,
          organizationId: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(
        emailQueueService.enqueueUserActivationEmail,
      ).not.toHaveBeenCalled();
    });
  });

  describe('password changed notifications', () => {
    it('queues a notification after account activation', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
        enqueuePasswordChangedEmail: jest
          .fn()
          .mockResolvedValue({ id: 'job-password-changed' }),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );
      const user = {
        id: 'user-1',
        email: 'agent@example.com',
        name: 'Agent',
        password: 'temporary-hash',
        isActive: false,
        activationTokenHash: 'activation-token-hash',
        activationTokenExpiresAt: new Date(Date.now() + 60_000),
        refreshToken: 'refresh-token',
      };
      repository.findOne.mockResolvedValue(user);
      repository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      await expect(
        service.activateAccount({
          token: 'activation-token',
          newPassword: 'NewPassword123',
          confirmNewPassword: 'NewPassword123',
        }),
      ).resolves.toEqual({ message: 'Account activated successfully' });

      expect(repository.save).toHaveBeenCalled();
      expect(user.isActive).toBe(true);
      expect(user.refreshToken).toBeNull();
      expect(
        emailQueueService.enqueuePasswordChangedEmail,
      ).toHaveBeenCalledWith({
        to: user.email,
        userName: user.name,
        changedAt: expect.any(String) as string,
      });
    });

    it('keeps account activation successful when notification enqueue fails', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
        enqueuePasswordChangedEmail: jest
          .fn()
          .mockRejectedValue(new Error('Redis unavailable')),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );
      repository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'agent@example.com',
        name: 'Agent',
        password: 'temporary-hash',
        isActive: false,
        activationTokenHash: 'activation-token-hash',
        activationTokenExpiresAt: new Date(Date.now() + 60_000),
        refreshToken: 'refresh-token',
      });
      repository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      await expect(
        service.activateAccount({
          token: 'activation-token',
          newPassword: 'NewPassword123',
          confirmNewPassword: 'NewPassword123',
        }),
      ).resolves.toEqual({ message: 'Account activated successfully' });
      expect(repository.save).toHaveBeenCalled();
    });

    it('queues a notification after changing the current password', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
        enqueuePasswordChangedEmail: jest
          .fn()
          .mockResolvedValue({ id: 'job-password-changed' }),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );
      const user = {
        id: 'user-1',
        email: 'agent@example.com',
        name: 'Agent',
        password: await bcrypt.hash('OldPassword123', 10),
        refreshToken: 'refresh-token',
      };
      repository.findOne.mockResolvedValue(user);
      repository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      await expect(
        service.changePassword('user-1', {
          currentPassword: 'OldPassword123',
          newPassword: 'NewPassword123',
          confirmNewPassword: 'NewPassword123',
        }),
      ).resolves.toEqual({ message: 'Password changed successfully' });

      expect(user.refreshToken).toBeNull();
      expect(await bcrypt.compare('NewPassword123', user.password)).toBe(true);
      expect(
        emailQueueService.enqueuePasswordChangedEmail,
      ).toHaveBeenCalledWith({
        to: user.email,
        userName: user.name,
        changedAt: expect.any(String) as string,
      });
    });

    it('keeps password change successful when notification enqueue fails', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
        enqueuePasswordChangedEmail: jest
          .fn()
          .mockRejectedValue(new Error('Redis unavailable')),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );
      repository.findOne.mockResolvedValue({
        id: 'user-1',
        email: 'agent@example.com',
        name: 'Agent',
        password: await bcrypt.hash('OldPassword123', 10),
        refreshToken: 'refresh-token',
      });
      repository.save.mockImplementation((entity: unknown) =>
        Promise.resolve(entity),
      );

      await expect(
        service.changePassword('user-1', {
          currentPassword: 'OldPassword123',
          newPassword: 'NewPassword123',
          confirmNewPassword: 'NewPassword123',
        }),
      ).resolves.toEqual({ message: 'Password changed successfully' });
      expect(repository.save).toHaveBeenCalled();
    });

    it('does not queue a notification when password validation fails', async () => {
      const repository = createRepositoryMock();
      const emailQueueService = {
        enqueueUserActivationEmail: jest.fn(),
        enqueuePasswordChangedEmail: jest.fn(),
      };
      const service = new UserService(
        repository as never,
        createMapperMock() as never,
        emailQueueService as never,
      );

      await expect(
        service.changePassword('user-1', {
          currentPassword: 'OldPassword123',
          newPassword: 'NewPassword123',
          confirmNewPassword: 'DifferentPassword123',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
      expect(
        emailQueueService.enqueuePasswordChangedEmail,
      ).not.toHaveBeenCalled();
    });
  });
});
