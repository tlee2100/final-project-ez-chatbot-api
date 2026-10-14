import { FilterOperator, PaginateConfig } from 'nestjs-paginate';
import { Document } from '../entities/document.entity';

export const DOCUMENT_PAGINATION_CONFIG: PaginateConfig<Document> = {
  sortableColumns: ['uploadedAt', 'filename', 'fileSizeBytes', 'fileType'],
  searchableColumns: ['filename'],
  filterableColumns: {
    fileType: [FilterOperator.EQ, FilterOperator.IN],
    status: [FilterOperator.EQ],
  },
  defaultSortBy: [['uploadedAt', 'DESC']],
  defaultLimit: 10,
  maxLimit: 100,
};
