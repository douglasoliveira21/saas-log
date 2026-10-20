import { IsEmail, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class RegisterDto {
  @IsString() @Length(2, 120, { message: 'Informe o nome da empresa.' }) companyName: string;
  @IsString() @Length(2, 120, { message: 'Informe seu nome.' }) name: string;
  @IsEmail({}, { message: 'E-mail inválido.' }) @MaxLength(200) email: string;
  @IsString() @MaxLength(200) password: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'E-mail inválido.' }) email: string;
  @IsString() @MaxLength(200) password: string;
}

export class SelectTenantDto {
  @IsUUID() tenantId: string;
}
