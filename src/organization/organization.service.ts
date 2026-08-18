import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectMapper } from '@automapper/nestjs';
import type { Mapper } from '@automapper/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { UserRole } from '../user/enums/user-role.enum';

import type { JwtUser } from '../auth/types/jwt-user.type';
import { User } from '../user/entities/user.entity';

import { Site } from '../site/entities/site.entity';
import { Organization } from './entities/organization.entity';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationDto } from './dto/organization.dto';
import { QueryOrganizationDto } from './dto/query-organization.dto';
import {
  DeleteOrganizationResponseDto,
  OrganizationResponseDto,
  PaginatedOrganizationsDto,
} from './dto/organization-response.dto';

@Injectable()
export class OrganizationService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: Repository<Organization>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectMapper()
    private readonly mapper: Mapper,
  ) {}

  async findAll(
    query: QueryOrganizationDto,
    user?: JwtUser,
  ): Promise<PaginatedOrganizationsDto> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;
    const sortBy = query.sortBy ?? 'createdAt';
    const order = query.order ?? 'DESC';

    const qb = this.organizationRepository
      .createQueryBuilder('organization')
      .leftJoinAndSelect('organization.owner', 'owner')
      // Subquery: count sites belonging to this organization (by organizationId or ownerId)
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(site.id)', 'cnt')
            .from('sites', 'site')
            .where(
              '(site.organizationId = organization.id OR (organization.ownerId IS NOT NULL AND site.ownerId = organization.ownerId))',
            ),
        'organization_sitesCount',
      )
      // Subquery: count AGENT-role users in this organization
      .addSelect(
        (sub) =>
          sub
            .select('COUNT(u.id)', 'cnt')
            .from('users', 'u')
            .where(
              '(u.organizationId = organization.id OR (organization.ownerId IS NOT NULL AND u.id = organization.ownerId))',
            )
            .andWhere(`u.role = '${UserRole.AGENT}'`),
        'organization_agentsCount',
      );

    if (user && user.role === UserRole.ADMIN) {
      // Find the org where the user is either a member (organizationId) or the owner (ownerId).
      // The OR covers the case where the JWT was issued before organizationId was set on the user.
      qb.andWhere(
        '(organization.id = :userOrgId OR organization.ownerId = :userId)',
        {
          userOrgId:
            user.organizationId ?? '00000000-0000-0000-0000-000000000000',
          userId: user.id,
        },
      );
    }

    if (query.name) {
      qb.andWhere('organization.name ILIKE :name', {
        name: `%${query.name}%`,
      });
    }

    if (query.slug) {
      qb.andWhere('organization.slug ILIKE :slug', {
        slug: `%${query.slug}%`,
      });
    }

    if (query.status) {
      qb.andWhere('organization.status = :status', {
        status: query.status,
      });
    }

    qb.orderBy(`organization.${sortBy}`, order).skip(skip).take(limit);

    // Use getRawAndEntities to access both mapped entities and raw subquery columns
    const { entities: organizations, raw: rawRows } =
      await qb.getRawAndEntities();
    const rawData = rawRows as Array<
      Record<string, string | number | undefined>
    >;
    const totalItems = await qb.getCount();
    const totalPages = Math.ceil(totalItems / limit);

    // Merge subquery counts from raw rows into entities
    const orgsWithCounts = organizations.map((org, idx) => {
      const row = rawData[idx];
      const sitesCountStr = String(row?.organization_sitesCount ?? '0');
      const agentsCountStr = String(row?.organization_agentsCount ?? '0');
      return {
        ...org,
        sitesCount: parseInt(sitesCountStr, 10),
        agentsCount: parseInt(agentsCountStr, 10),
      };
    });

    return {
      data: orgsWithCounts.map((org) => this.toDto(org)),
      meta: {
        page,
        limit,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async create(
    createOrganizationDto: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    await this.assertSlugAvailable(createOrganizationDto.slug);

    // Validate a provided owner exists and is an ADMIN before saving,
    // rather than surfacing a raw FK violation or allowing a non-admin owner.
    if (createOrganizationDto.ownerId) {
      const owner = await this.userRepository.findOne({
        where: { id: createOrganizationDto.ownerId },
      });
      if (!owner) {
        throw new NotFoundException(
          `Owner user '${createOrganizationDto.ownerId}' not found`,
        );
      }
      if (owner.role !== UserRole.ADMIN) {
        throw new ForbiddenException(
          'Organization owner must be a user with the ADMIN role',
        );
      }
    }

    const organization = this.organizationRepository.create(
      createOrganizationDto,
    );
    const saved = await this.organizationRepository.save(organization);
    // Reload with the owner relation so the response includes owner info.
    const reloaded = await this.findOrganizationEntity(saved.id);

    return { data: this.toDto(reloaded) };
  }

  async findOne(id: string, user: JwtUser): Promise<OrganizationResponseDto> {
    const organization = await this.findOrganizationEntity(id);
    this.assertCanReadOrganization(organization, user);

    return { data: this.toDto(organization) };
  }

  async update(
    id: string,
    updateOrganizationDto: UpdateOrganizationDto,
    user: JwtUser,
  ): Promise<OrganizationResponseDto> {
    const organization = await this.findOrganizationEntity(id);

    this.assertCanUpdateOrganization(organization, user);

    if (updateOrganizationDto.slug) {
      await this.assertSlugAvailable(updateOrganizationDto.slug, id);
    }

    Object.assign(organization, updateOrganizationDto);

    const saved = await this.organizationRepository.save(organization);
    // Reload with owner relation so toDto can include owner info
    const reloaded = await this.findOrganizationEntity(saved.id);

    return { data: this.toDto(reloaded) };
  }

  async remove(
    id: string,
    user: JwtUser,
  ): Promise<DeleteOrganizationResponseDto> {
    const organization = await this.findOrganizationEntity(id);

    // Permission check: Super Admin or Admin Owner
    this.assertCanUpdateOrganization(organization, user);

    const [userCount, siteCount] = await Promise.all([
      this.userRepository.count({ where: { organizationId: id } }),
      this.siteRepository.count({
        where: [
          { organizationId: id },
          ...(organization.ownerId ? [{ ownerId: organization.ownerId }] : []),
        ],
      }),
    ]);

    if (userCount > 0 || siteCount > 0) {
      throw new ConflictException({
        error: 'DELETE_FAILED',
        message: 'Organization cannot be deleted while it has users or sites',
        details: {
          users: userCount,
          sites: siteCount,
        },
      });
    }

    await this.organizationRepository.remove(organization);

    return { data: { id } };
  }

  private async findOrganizationEntity(id: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id },
      relations: { owner: true },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  private async assertSlugAvailable(
    slug: string,
    ignoreId?: string,
  ): Promise<void> {
    const existingOrganization = await this.organizationRepository.findOne({
      where: ignoreId ? { slug, id: Not(ignoreId) } : { slug },
    });

    if (existingOrganization) {
      throw new ConflictException({
        error: 'CONFLICT',
        message: 'Organization with this slug already exists',
        details: {
          field: 'slug',
        },
      });
    }
  }

  private isSuperAdmin(user: JwtUser): boolean {
    return user.role === UserRole.SUPER_ADMIN;
  }

  private isOrganizationOwner(
    organization: Organization,
    user: JwtUser,
  ): boolean {
    return user.role === UserRole.ADMIN && organization.ownerId === user.id;
  }

  private canReadOrganization(
    organization: Organization,
    user: JwtUser,
  ): boolean {
    return this.isSuperAdmin(user) || organization.id === user.organizationId;
  }

  private canUpdateOrganization(
    organization: Organization,
    user: JwtUser,
  ): boolean {
    return (
      this.isSuperAdmin(user) || this.isOrganizationOwner(organization, user)
    );
  }

  private assertCanReadOrganization(
    organization: Organization,
    user: JwtUser,
  ): void {
    if (!this.canReadOrganization(organization, user)) {
      throw new ForbiddenException(
        'You do not have permission to read organization',
      );
    }
  }

  private assertCanUpdateOrganization(
    organization: Organization,
    user: JwtUser,
  ): void {
    if (!this.canUpdateOrganization(organization, user)) {
      throw new ForbiddenException(
        'You do not have permission to update organization',
      );
    }
  }

  private toDto(
    organization: Organization & { sitesCount?: number; agentsCount?: number },
  ): OrganizationDto {
    let initials = 'U';
    const owner = organization.owner;

    if (owner?.name) {
      const names = owner.name.trim().split(' ');
      initials =
        names.length > 1
          ? `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase()
          : names[0].substring(0, 2).toUpperCase();
    } else if (owner?.email) {
      initials = owner.email.substring(0, 2).toUpperCase();
    }

    return {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status ?? 'Active',
      notes: organization.notes ?? null,
      ownerId: organization.ownerId ?? null,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      owner: owner
        ? {
            id: owner.id,
            name: owner.name,
            email: owner.email,
            avatarUrl: owner.avatarUrl ?? null,
          }
        : null,
      adminOwner: owner
        ? {
            name: owner.name || owner.email?.split('@')[0] || 'Unknown',
            email: owner.email || '',
            avatar: owner.avatarUrl ?? null,
            initials,
          }
        : null,
      ownersCount: owner ? 1 : 0,
      sitesCount: organization.sitesCount ?? 0,
      agentsCount: organization.agentsCount ?? 0,
    };
  }
}
