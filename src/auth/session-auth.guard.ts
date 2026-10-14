import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * A valid staff JWT and nothing else: unlike `JwtAuthGuard` it does not look at the tenant's
 * status. Used by logout (J1), which must work for someone whose workspace is suspended or closed:
 * otherwise their old tokens would come back to life when the tenant is reactivated.
 */
@Injectable()
export class SessionAuthGuard extends AuthGuard('jwt') {}
