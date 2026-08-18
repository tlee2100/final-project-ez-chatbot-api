import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { Site } from '../entities/site.entity';

export const SITE_PAGINATION_CONFIG: PaginateConfig<Site> = {
  sortableColumns: [
    'name',
    'url',
    'knowledgeBaseStatus',
    'ownerId',
    'isAiActive',
  ],
  searchableColumns: ['name'],
  filterableColumns: {
    knowledgeBaseStatus: [FilterOperator.EQ],
    name: [FilterOperator.ILIKE],
    isAiActive: [FilterOperator.EQ],
  },
  defaultSortBy: [['name', 'ASC']],
  defaultLimit: 10,
  maxLimit: 100,
};
