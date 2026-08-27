import { ConflictException } from '@nestjs/common';

jest.mock('@automapper/nestjs', () => ({
  InjectMapper: () => () => undefined,
}));
jest.mock('@automapper/classes', () => ({
  AutoMap: () => () => undefined,
}));

import {
  createMapperMock,
  createQueryBuilderMock,
  createRepositoryMock,
} from '../test/service-test-helpers';
import { OrganizationService } from './organization.service';
import { UserRole } from '../user/enums/user-role.enum';

describe('OrganizationService access rules', () => {
  let organizationRepository: ReturnType<typeof createRepositoryMock>;
  let userRepository: ReturnType<typeof createRepositoryMock>;
  let siteRepository: ReturnType<typeof createRepositoryMock>;
  let service: OrganizationService;

  beforeEach(() => {
    organizationRepository = createRepositoryMock();
    userRepository = createRepositoryMock();
    siteRepository = createRepositoryMock();
    service = new OrganizationService(
      organizationRepository as never,
      userRepository as never,
      siteRepository as never,
      createMapperMock() as never,
    );
  });

  it('allows SUPER_ADMIN full organization listing across orgs', async () => {
    const qb = createQueryBuilderMock([{ id: 'org-a' }, { id: 'org-b' }]);
    organizationRepository.createQueryBuilder.mockReturnValue(qb);

    const result = await service.findAll({});

    expect(result.data).toHaveLength(2);
    expect(qb.getRawAndEntities).toHaveBeenCalled();
  });

  it('returns 409 CONFLICT for duplicate slug', async () => {
    organizationRepository.findOne.mockResolvedValue({ id: 'existing-org' });

    await expect(
      service.create({ name: 'Acme', slug: 'acme' }),
    ).rejects.toMatchObject({
      response: {
        error: 'CONFLICT',
        details: { field: 'slug' },
      },
    });
  });

  it('blocks deleting organizations that still have users or sites', async () => {
    const mockSuperAdmin = {
      id: 'user-1',
      email: 'admin@test.com',
      role: UserRole.SUPER_ADMIN,
      organizationId: null,
    };
    organizationRepository.findOne.mockResolvedValue({ id: 'org-a' });
    userRepository.count.mockResolvedValue(1);
    siteRepository.count.mockResolvedValue(2);

    await expect(
      service.remove('org-a', mockSuperAdmin),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove('org-a', mockSuperAdmin)).rejects.toMatchObject(
      {
        response: {
          error: 'DELETE_FAILED',
          details: { users: 1, sites: 2 },
        },
      },
    );
  });

  it('returns 409 CONFLICT if user already owns another organization', async () => {
    organizationRepository.findOne
      .mockResolvedValueOnce(null) // slug check: available
      .mockResolvedValueOnce({ id: 'org-1', name: 'Existing Org' }); // owner check: already owns org-1

    await expect(
      service.create({
        name: 'New Org',
        slug: 'new-org',
        ownerId: 'user-admin-1',
      }),
    ).rejects.toMatchObject({
      response: {
        error: 'CONFLICT',
        details: { field: 'ownerId' },
      },
    });
  });
});
