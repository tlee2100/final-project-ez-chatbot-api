import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { User } from '../entities/user.entity';

export const USER_PAGINATION_CONFIG: PaginateConfig<User> = {
  sortableColumns: ['name', 'email', 'role'],
  searchableColumns: ['name', 'email'],
  filterableColumns: {
    role: [FilterOperator.EQ],
    name: [FilterOperator.ILIKE],
    email: [FilterOperator.ILIKE],
  },
  defaultSortBy: [['name', 'ASC']],
  defaultLimit: 10,
  maxLimit: 100,
};
