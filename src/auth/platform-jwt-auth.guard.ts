import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guards `/v1/admin/...` routes: only a valid platform-admin token passes. */
@Injectable()
export class PlatformJwtAuthGuard extends AuthGuard('platform-jwt') {}
