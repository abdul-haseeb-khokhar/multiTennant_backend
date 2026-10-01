import { IsString, IsEmail, MinLength } from "class-validator";

export class SignupDto {
    @IsString()
    tenantName: string;

    @IsEmail()
    ownerEmail: string;

    @IsString()
    @MinLength(8)
    ownerPassword: string;
}