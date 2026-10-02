import { IsString, IsOptional, IsObject } from "class-validator";

export class CreateEndCustomerDto {
    @IsString()
    externalId: string;

    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;
}
