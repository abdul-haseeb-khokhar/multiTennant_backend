import { SetMetadata } from '@nestjs/common';

/** Staff roles inside a tenant (B2). */
export const ROLES = ['owner', 'admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What the JWT strategy puts on `request.user` for a tenant staff member. `role` and
 * `emailVerified` are read from the database on every request, not from the token, so a role
 * change or a verification takes effect immediately.
 */
export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
  /** Whether the user has confirmed their email address (H4); gates inviting staff and plan changes. */
  emailVerified: boolean;
}

export const ROLES_KEY = 'roles';

/**
 * Roles allowed to call a route. `RolesGuard` fails closed: a route behind it without `@Roles`
 * is refused, so every handler states who may use it.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
