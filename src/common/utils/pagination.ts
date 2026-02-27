export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
  totalCount: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
}

export function calculatePagination(
  totalCount: number,
  page: number = 1,
  pageSize: number = 10,
): PageInfo {
  const currentPage = Math.max(1, page);
  const totalPages = Math.ceil(totalCount / pageSize);
  const hasNextPage = currentPage < totalPages;
  const hasPreviousPage = currentPage > 1;
  const startCursor = totalCount > 0 ? currentPage.toString() : null;
  const endCursor = totalCount > 0 ? currentPage.toString() : null;

  return {
    hasNextPage,
    hasPreviousPage,
    startCursor,
    endCursor,
    totalCount,
    totalPages,
    currentPage,
    pageSize,
  };
}

export function calculatePrismaParams(page: number = 1, pageSize: number = 10) {
  const currentPage = Math.max(1, page);
  const skip = (currentPage - 1) * pageSize;
  const take = pageSize;

  return { skip, take };
}

export function createPaginatedResponse<T>(
  items: T[],
  totalCount: number,
  page: number = 1,
  pageSize: number = 10,
) {
  return {
    nodes: items,
    pageInfo: calculatePagination(totalCount, page, pageSize),
  };
}
