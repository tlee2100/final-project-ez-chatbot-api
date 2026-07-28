import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { Site } from '../entities/site.entity';

export const SITE_PAGINATION_CONFIG: PaginateConfig<Site> = {
  sortableColumns: ['name', 'url', 'knowledgeBaseStatus', 'ownerId'],
  searchableColumns: ['name'],
  filterableColumns: {
    knowledgeBaseStatus: [FilterOperator.EQ],
    name: [FilterOperator.ILIKE],
  },
  defaultSortBy: [['name', 'ASC']],
  defaultLimit: 10,
  maxLimit: 100,
};
