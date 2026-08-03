import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { type PaginateQuery, type Paginated, paginate } from 'nestjs-paginate';
import type { Mapper } from '@automapper/core';
import { InjectMapper } from '@automapper/nestjs';

import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { Site } from './entities/site.entity';
import { User } from '../user/entities/user.entity';
import { SiteDto } from './dto/site.dto';
import { UserRole } from '../user/enums/user-role.enum';
import type { JwtUser } from 'src/auth/types/jwt-user.type';
import { SITE_PAGINATION_CONFIG } from './config/site-pagination.config';

type PaginatedSiteDtos = Omit<Paginated<Site>, 'data'> & {
  data: SiteDto[];
};

@Injectable()
export class SiteService {
  constructor(
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectMapper()
    private readonly mapper: Mapper,
  ) {}

  // ── Create Site ──
  async create(createSiteDto: CreateSiteDto, user: JwtUser): Promise<SiteDto> {
    const { agentIds, organizationId: dtoOrgId, ...siteData } = createSiteDto;

    // Determine which organization the new site belongs to.
    let organizationId: string | null;
    if (user.role === UserRole.SUPER_ADMIN) {
      organizationId = dtoOrgId ?? user.organizationId ?? null;
    } else {
      // Admins can only create sites within their own organization.
      if (!user.organizationId) {
        throw new BadRequestException(
          'Admin must belong to an organization to create a site',
        );
      }
      organizationId = user.organizationId;
    }

    const owner = await this.userRepository.findOne({
      where: { id: user.id },
    });

    if (!owner) {
      throw new NotFoundException('Owner not found');
    }

    // An organization-scoped admin must belong to an organization so the site
    // is tenant-bound. Super-admins may create tenantless sites.
    if (owner.role === UserRole.ADMIN && !owner.organizationId) {
      throw new BadRequestException(
        'Admin must belong to an organization to create a site',
      );
    }

    const existingSite = await this.siteRepository.findOne({
      where: { url: siteData.url },
    });
    if (existingSite) {
      throw new ConflictException('Site with this URL already exists');
    }

    const site = this.siteRepository.create({
      ...siteData,
      owner,
      organizationId,
    });

    if (agentIds?.length) {
      const agents = await this.userRepository.find({
        where: {
          id: In(agentIds),
          role: UserRole.AGENT,
        },
      });
      site.agents = agents;
    }

    const savedSite = await this.siteRepository.save(site);
    return this.mapper.map(savedSite, Site, SiteDto);
  }

  // ── Find All (Paginated) ──
  async findAll(
    query: PaginateQuery,
    user: JwtUser,
  ): Promise<PaginatedSiteDtos> {
    const qb = this.siteRepository
      .createQueryBuilder('site')
      .leftJoinAndSelect('site.owner', 'owner')
      .leftJoinAndSelect('site.agents', 'agents')
      .loadRelationIdAndMap('site.documentIds', 'site.documents');

    // Organization-based visibility: non-super-admin users only see sites
    // belonging to their own organization.
    if (user.role !== UserRole.SUPER_ADMIN) {
      if (user.organizationId) {
        qb.andWhere('site.organizationId = :orgId', {
          orgId: user.organizationId,
        });
      } else {
        // Belongs to no organization — see nothing.
        qb.andWhere('1 = 0');
      }
    }

    // Agents additionally see only the sites they are assigned to (now also
    // constrained to their own organization by the filter above).
    if (user.role === UserRole.AGENT) {
      qb.innerJoin('site.agents', 'agent', 'agent.id = :agentId', {
        agentId: user.id,
      });
    } else if (user.role === UserRole.ADMIN && user.organizationId) {
      qb.andWhere('site.organizationId = :orgId', {
        orgId: user.organizationId,
      });
    }

    const paginated = await paginate(query, qb, SITE_PAGINATION_CONFIG);

    return {
      ...paginated,
      data: this.mapper.mapArray(paginated.data, Site, SiteDto),
    };
  }

  // ── Find One Site Entity (Internal) ──
  async findOneEntity(id: string): Promise<Site> {
    const site = await this.siteRepository.findOne({
      where: { id },
      relations: { owner: true, agents: true, documents: true },
    });
    if (!site) {
      throw new NotFoundException(`Site with id ${id} not found`);
    }
    return site;
  }

  // ── Find One Site Dto (Public — no authorization; caller exposes only
  //    deliberately public fields) ──
  async findOne(id: string): Promise<SiteDto> {
    const site = await this.findOneEntity(id);
    return this.mapper.map(site, Site, SiteDto);
  }

  // ── Find One Site Dto (Access-checked) ──
  async findOneWithAccess(id: string, user: JwtUser): Promise<SiteDto> {
    const site = await this.assertSiteAccess(id, user);
    return this.mapper.map(site, Site, SiteDto);
  }

  // ── Assert access helper ──
  async assertSiteAccess(siteId: string, user: JwtUser): Promise<Site> {
    const site = await this.findOneEntity(siteId);

    // Super admins have unrestricted access.
    if (user.role === UserRole.SUPER_ADMIN) {
      return site;
    }

    // Every other role may only access sites within their own organization.
    if (!user.organizationId || site.organizationId !== user.organizationId) {
      throw new ForbiddenException('You do not have access to this site');
    }

    // Within their organization, admins have full access.
    if (user.role === UserRole.ADMIN) {
      return site;
    }

    // Agents must be the owner of or be assigned to the site.
    const isOwner = site.ownerId === user.id;
    const isAssignedAgent = site.agents.some((agent) => agent.id === user.id);

    if (!isOwner && !isAssignedAgent) {
      throw new ForbiddenException('You do not have access to this site');
    }
    return site;
  }

  // ── Update Site ──
  async update(
    id: string,
    dto: UpdateSiteDto,
    user: JwtUser,
  ): Promise<SiteDto> {
    const site = await this.assertSiteAccess(id, user);

    if (dto.url && dto.url !== site.url) {
      const existingSite = await this.siteRepository.findOne({
        where: { url: dto.url },
      });
      if (existingSite && existingSite.id !== id) {
        throw new ConflictException('Site with this URL already exists');
      }
    }

    await this.siteRepository.update(id, dto);
    return this.findOne(id);
  }

  // ── Delete Site ──
  async remove(id: string, user: JwtUser): Promise<void> {
    await this.assertSiteAccess(id, user);
    await this.siteRepository.delete(id);
  }

  // ── Assign Agent ──
  async assignAgent(
    siteId: string,
    agentId: string,
    user: JwtUser,
  ): Promise<SiteDto> {
    const site = await this.assertSiteAccess(siteId, user);

    const alreadyAssigned = site.agents.some((agent) => agent.id === agentId);
    if (alreadyAssigned) {
      throw new BadRequestException('Agent is already assigned to this site');
    }

    await this.siteRepository
      .createQueryBuilder()
      .relation(Site, 'agents')
      .of(siteId)
      .add(agentId);

    return this.findOne(siteId);
  }

  // ── Remove Agent ──
  async removeAgent(
    siteId: string,
    agentId: string,
    user: JwtUser,
  ): Promise<SiteDto> {
    await this.assertSiteAccess(siteId, user);

    await this.siteRepository
      .createQueryBuilder()
      .relation(Site, 'agents')
      .of(siteId)
      .remove(agentId);

    return this.findOne(siteId);
  }

  // ── Access-policy helpers ──
  private canAccessSite(site: Site, user: JwtUser): boolean {
    if (
      this.isSuperAdmin(user) ||
      this.isAdminOfSite(site, user) ||
      site.ownerId === user.id
    ) {
      return true;
    }
    if (user.role === UserRole.AGENT) {
      return site.agents.some((agent) => agent.id === user.id);
    }
    return false;
  }

  private isSuperAdmin(user: JwtUser): boolean {
    return user.role === UserRole.SUPER_ADMIN;
  }

  private isAdminOfSite(site: Site, user: JwtUser): boolean {
    return (
      user.role === UserRole.ADMIN &&
      user.organizationId !== null &&
      site.organizationId === user.organizationId
    );
  }
}
