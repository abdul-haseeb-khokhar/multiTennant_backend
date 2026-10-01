import { ExecutionContext, Injectable, ForbiddenException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Observable } from "rxjs";

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isAuthenticated = (await super.canActivate(context)) as boolean;
        if(!isAuthenticated) {
            return false;
        }

        const request = context.switchToHttp().getRequest();
        const routeTenantId = request.params.tenantId;
        if(routeTenantId && routeTenantId !== request.user.tenantId) {
            throw new ForbiddenException('You do not have access to this tenant');
        }
        return true;
    }
}