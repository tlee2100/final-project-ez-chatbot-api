import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { type PaginateQuery, type Paginated, paginate } from 'nestjs-paginate';
import type { Mapper } from '@automapper/core';
import { InjectMapper } from '@automapper/nestjs';

import { CreateSiteDto } from './dto/create-site.dto';
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
    private mapper: Mapper,
  ) {}

  async findAll(
    query: PaginateQuery,
    user: JwtUser,
  ): Promise<PaginatedSiteDtos> {
    const qb = this.siteRepository.createQueryBuilder('site');

    if (user.role === UserRole.AGENT) {
      qb.innerJoin('site.agents', 'agent', 'agent.id = :agentId', {
        agentId: user.id,
      });
    }

    const paginated = await paginate(query, qb, SITE_PAGINATION_CONFIG);

    return {
      ...paginated,
      data: this.mapper.mapArray(paginated.data, Site, SiteDto),
    };
  }

  async create(createSiteDto: CreateSiteDto, userId: string) {
    const { agentIds, ...siteData } = createSiteDto;

    const owner = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!owner) {
      throw new NotFoundException('Owner not found');
    }

    const site = this.siteRepository.create({
      ...siteData,
      owner,
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

    const siteDto = this.mapper.map(savedSite, Site, SiteDto);

    return siteDto;
  }
}
