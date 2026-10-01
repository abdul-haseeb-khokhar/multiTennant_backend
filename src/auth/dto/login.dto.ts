import { IsString, IsEmail } from "class-validator";

export class LoginDto {
    @IsString()
    tenantId: string;

    @IsEmail()
    email: string;

    @IsString()
    password: string;
}