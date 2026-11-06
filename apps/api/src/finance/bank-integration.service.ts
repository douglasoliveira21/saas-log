import { BadRequestException, Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { IsBase64, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../integrations/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

export class BankIntegrationDto {
  @IsIn(['SICOOB']) provider: 'SICOOB';
  @IsIn(['SANDBOX', 'PRODUCTION']) environment: 'SANDBOX' | 'PRODUCTION';
  @IsOptional() @IsString() @MaxLength(120) clientId?: string;
  @IsOptional() @IsString() @MaxLength(300) clientSecret?: string;
  @IsOptional() @IsBase64() @MaxLength(8_000_000) certificateBase64?: string;
  @IsOptional() @IsString() @MaxLength(300) certificatePassword?: string;
  @IsOptional() @IsString() @MaxLength(30) cooperative?: string;
  @IsOptional() @IsString() @MaxLength(30) agency?: string;
  @IsOptional() @IsString() @MaxLength(40) accountNumber?: string;
  @IsOptional() @IsString() @MaxLength(30) wallet?: string;
  @IsOptional() @IsString() @MaxLength(200) pixKey?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Injectable()
export class BankIntegrationService {
  constructor(private readonly prisma: PrismaService, private readonly crypto: CryptoService, private readonly audit: AuditService) {}

  get(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.bankIntegration.findUnique({ where: { tenantId: ctx.tenantId! } });
      if (!row) return { configured: false, provider: null, environment: null, enabled: false };
      return { configured: true, provider: row.provider, environment: row.environment, enabled: row.enabled, cooperative: row.cooperative, agency: row.agency, accountNumber: row.accountNumber, wallet: row.wallet, pixKey: row.pixKey, hasClientId: !!row.clientIdEnc, hasClientSecret: !!row.clientSecretEnc, hasCertificate: !!row.certificateEnc, webhookRegisteredAt: row.webhookRegisteredAt };
    });
  }

  save(ctx: AuthContext, dto: BankIntegrationDto) {
    if (dto.provider !== 'SICOOB') throw new BadRequestException('Provedor bancário não suportado.');
    return this.prisma.withContext(ctx, async (tx) => {
      const id = (await tx.bankIntegration.findUnique({ where: { tenantId: ctx.tenantId! }, select: { id: true } }))?.id;
      const secret = (name: keyof BankIntegrationDto, value: string | undefined) => value === undefined ? undefined : this.crypto.encrypt(ctx.tenantId!, `bank:${name}`, { value });
      const clientIdEnc = secret('clientId', dto.clientId);
      const clientSecretEnc = secret('clientSecret', dto.clientSecret);
      const certificateEnc = secret('certificateBase64', dto.certificateBase64);
      const certificatePasswordEnc = secret('certificatePassword', dto.certificatePassword);
      const data = {
        provider: dto.provider, environment: dto.environment, cooperative: dto.cooperative?.trim() || null, agency: dto.agency?.trim() || null,
        accountNumber: dto.accountNumber?.trim() || null, wallet: dto.wallet?.trim() || null, pixKey: dto.pixKey?.trim() || null,
        enabled: dto.enabled ?? false, ...(clientIdEnc ? { clientIdEnc } : {}),
        ...(clientSecretEnc ? { clientSecretEnc } : {}), ...(certificateEnc ? { certificateEnc } : {}),
        ...(certificatePasswordEnc ? { certificatePasswordEnc } : {}),
      };
      const row = id ? await tx.bankIntegration.update({ where: { id }, data }) : await tx.bankIntegration.create({ data: { tenantId: ctx.tenantId!, ...data } });
      await this.audit.record(tx, ctx, { action: 'finance.bank_integration_saved', entity: 'bank_integration', entityId: row.id, metadata: { provider: dto.provider, environment: dto.environment, enabled: dto.enabled ?? false } });
      return { configured: true, provider: row.provider, environment: row.environment, enabled: row.enabled, cooperative: row.cooperative, agency: row.agency, accountNumber: row.accountNumber, wallet: row.wallet, pixKey: row.pixKey, hasClientId: !!row.clientIdEnc, hasClientSecret: !!row.clientSecretEnc, hasCertificate: !!row.certificateEnc, webhookRegisteredAt: row.webhookRegisteredAt };
    });
  }
}

@Controller('finance/bank-integration')
export class BankIntegrationController {
  constructor(private readonly svc: BankIntegrationService) {}
  @Get() @RequirePermissions('finance.view') get(@CurrentAuth() ctx: AuthContext) { return this.svc.get(ctx); }
  @Put() @RequirePermissions('finance.manage') save(@CurrentAuth() ctx: AuthContext, @Body() dto: BankIntegrationDto) { return this.svc.save(ctx, dto); }
}
