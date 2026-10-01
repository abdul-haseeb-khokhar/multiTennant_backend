import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { TenantUsersService } from '../tenant-users/tenant-users.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { PrismaService } from '../prisma/prisma.service';

const SALT_ROUNDS = 10;

@Injectable()
export class AuthService {
    constructor(
        private readonly tenantUsersService: TenantUsersService,
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
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

    async signup(dto:SignupDto) {
        const passwordHash = await bcrypt.hash(dto.ownerPassword, SALT_ROUNDS);

        const {tenant, owner} = await this.prisma.$transaction(
            async(tx) => {
                const tenant = await tx.tenant.create({
                    data: {name: dto.tenantName},
                });

                const owner = await tx.tenantUser.create({
                    data: {
                        tenantId: tenant.id,
                        email: dto.ownerEmail,
                        passwordHash,
                        role: 'owner',
                    },
                    omit : {passwordHash: true},
                });
                return {tenant, owner};
            }
        );
        const payload = {sub: owner.id, tenantId: tenant.id, role: owner.role};
        return {tenant, owner, access_token: this.jwtService.sign(payload)};
    }
}
