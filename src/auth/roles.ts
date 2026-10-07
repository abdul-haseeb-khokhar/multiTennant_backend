import { SetMetadata } from '@nestjs/common';

/** Staff roles inside a tenant (B2). */
export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

/** What the JWT strategies put on `request.user` for a tenant staff member. */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
}

export const ROLES_KEY = 'roles';

/**
 * Roles allowed to call a route. `RolesGuard` fails closed: a route behind it without `@Roles`
 * is refused, so every handler states who may use it.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
