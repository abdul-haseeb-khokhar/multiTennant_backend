import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { TenantUsersService } from '../tenant-users/tenant-users.service';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
    constructor(
        private readonly tenantUsersService: TenantUsersService,
        private readonly jwtService: JwtService,
    ) {}

    async login(dto: LoginDto) {
        const user = await this.tenantUsersService.findByEmailForAuth(dto.tenantId, dto.email);
        if(!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
        if(!passwordMatches) {
            throw new UnauthorizedException('Invalid credentials');
        }

        const payload = {sub: user.id, tenantId: user.tenantId, role: user.role};
        return {access_token: this.jwtService.sign(payload)};
    }
}
