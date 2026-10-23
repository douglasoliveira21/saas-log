import { IsEmail, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

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

export class ProfileDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  /** Telefone com DDD; vazio apaga. */
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
}
export class PasswordDto {
  @IsString() @MaxLength(200) currentPassword: string;
  @IsString() @MaxLength(200) newPassword: string;
}
export class AvatarDto {
  @IsIn(['image/png', 'image/jpeg', 'image/webp']) contentType: string;
  /** Imagem em base64, sem o prefixo data:. */
  @IsString() @MaxLength(Math.ceil((512 * 1024 * 4) / 3) + 8) contentBase64: string;
}
export class MfaVerifyDto {
  @IsString() @MaxLength(2000) mfaToken: string;
  @IsString() @MaxLength(32) code: string;
}
export class MfaCodeDto { @IsString() @MaxLength(32) code: string }
export class MfaDisableDto {
  @IsString() @MaxLength(200) password: string;
  @IsString() @MaxLength(32) code: string;
}
export class ForgotDto { @IsEmail({}, { message: 'E-mail inválido.' }) @MaxLength(200) email: string }
export class ResetDto {
  @IsString() @MaxLength(200) token: string;
  @IsString() @MaxLength(200) password: string;
}
export class AcceptInviteDto {
  @IsString() @MaxLength(300) token: string;
  @IsString() @MaxLength(200) password: string;
  @IsOptional() @IsString() @Length(2, 120) name?: string;
}
