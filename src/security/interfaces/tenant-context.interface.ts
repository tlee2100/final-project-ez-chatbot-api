/**
 * Represents the resolved tenant context attached to each authenticated request.
 * Populated by TenantScopeInterceptor and used to enforce multi-tenant isolation.
 */
export interface TenantContext {
  /** The site (tenant) ID extracted from the route param :siteId */
  siteId: string;
  /** The authenticated user's organisation ID (from JWT payload) */
  organizationId: string;
  /** The authenticated user's ID */
  userId: string;
}
