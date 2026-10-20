import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { AllowNoTenant, AuthContext, AuthedRequest, COOKIE_REFRESH, CurrentAuth, Public } from '../common/auth';
import { LoginDto, RegisterDto, SelectTenantDto } from './auth.dto';
import { AuthService, RequestMeta } from './auth.service';

const meta = (req: AuthedRequest): RequestMeta => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
