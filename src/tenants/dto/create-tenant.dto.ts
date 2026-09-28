import { IsString, IsOptional, isIn, isString, IsIn } from "class-validator";
export class CreateTenantDto {
    @IsString()
    name: string;

    @IsOptional()
    @IsIn(['free', 'pro', 'enterprise'])
    plan?: string;

    @IsOptional()
    @IsIn(['trial', 'active', 'suspended'])
    status?: string;
}

