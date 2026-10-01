import { Injectable } from "@nestjs/common";
import {PassportStrategy} from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor() {
        const jwtSecret = process.env.JWT_SECRET;
        if(!jwtSecret) {
            throw new Error ('JWT_SECRET enviroment variable is not set');
        }
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: jwtSecret,
        });
    }
    validate(payload: {sub: string; tenantId: string; role: string}) {
        return {userId: payload.sub, tenantId: payload.tenantId, role: payload.role}
    }
}