import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AllowNoTenant, AuthContext, AuthedRequest, COOKIE_REFRESH, CurrentAuth, Public } from '../common/auth';
import { ForgotDto, LoginDto, MfaCodeDto, MfaDisableDto, MfaVerifyDto, RegisterDto, ResetDto, SelectTenantDto } from './auth.dto';
import { RecoveryService } from './recovery.service';
import { AuthService, RequestMeta } from './auth.service';

const meta = (req: AuthedRequest): RequestMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly recovery: RecoveryService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.register(dto, res, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/verify')
  mfaVerify(@Body() dto: MfaVerifyDto, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.verifyMfa(dto, res, meta(req));
  }

  @AllowNoTenant()
  @Get('mfa')
  mfaStatus(@CurrentAuth() ctx: AuthContext) { return this.auth.mfaStatus(ctx); }

  @AllowNoTenant()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/setup')
  mfaSetup(@CurrentAuth() ctx: AuthContext) { return this.auth.mfaSetup(ctx); }

  @AllowNoTenant()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/enable')
  mfaEnable(@CurrentAuth() ctx: AuthContext, @Body() dto: MfaCodeDto) { return this.auth.mfaEnable(ctx, dto.code); }

  @AllowNoTenant()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('mfa/disable')
  mfaDisable(@CurrentAuth() ctx: AuthContext, @Body() dto: MfaDisableDto) { return this.auth.mfaDisable(ctx, dto.password, dto.code); }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgot(@Body() dto: ForgotDto) { return this.recovery.forgot(dto.email); }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('reset-password')
  reset(@Body() dto: ResetDto) { return this.recovery.reset(dto.token, dto.password); }

  @AllowNoTenant()
  @HttpCode(200)
  @Post('select-tenant')
  selectTenant(
    @CurrentAuth() ctx: AuthContext,
    @Body() dto: SelectTenantDto,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.selectTenant(ctx, dto.tenantId, res, meta(req));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  refresh(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req.cookies?.[COOKIE_REFRESH] as string | undefined, res, meta(req));
  }

  @Public()
  @HttpCode(200)
  @Post('logout')
  logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.cookies?.[COOKIE_REFRESH] as string | undefined, res);
  }

  @AllowNoTenant()
  @Get('me')
  me(@CurrentAuth() ctx: AuthContext) {
    return this.auth.me(ctx);
  }
}
