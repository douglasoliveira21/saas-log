import { Controller, Get, INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AuditController, AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { Public } from './common/auth';
import { getConfig } from './config/app.config';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { StructureController } from './structure/structure.controller';
import { StructureService } from './structure/structure.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { StockController } from './stock/stock.controller';
import { StockService } from './stock/stock.service';
import { CommissionsService } from './commissions/commissions.service';
import { CustomersController, CustomersService } from './customers/customers.service';
import { PurchasingController } from './purchasing/purchasing.controller';
import { PurchasingService } from './purchasing/purchasing.service';
import { SalesController } from './sales/sales.controller';
import { SalesService } from './sales/sales.service';
import { SettingsController, SettingsService } from './settings/settings.service';
import { ConnectionsService } from './integrations/connections.service';
import { CryptoService } from './integrations/crypto.service';
import { JobQueue } from './integrations/job-queue';
import { JobWorker } from './integrations/jobs.service';
import { IntegrationsController, WebhooksController, WebhooksService } from './integrations/integrations.controller';
import { ConnectorRegistry } from './integrations/providers';
import { OrderImportService } from './integrations/order-import.service';
import { ChannelCatalogService } from './integrations/channel-catalog.service';
import { FiscalConfigService } from './fiscal/fiscal-config.service';
import { FiscalController } from './fiscal/fiscal.controller';
import { FiscalInboundService } from './fiscal/fiscal-inbound.service';
import { FiscalOutgoingService } from './fiscal/fiscal-outgoing.service';
import { FISCAL_PROVIDER } from './fiscal/fiscal-provider';
import { FiscalProviderRouter, ProviderContextService } from './fiscal/fiscal-provider.router';
import { IbgeService } from './fiscal/sefaz/ibge';
import { TaxRulesService } from './fiscal/tax-rules.service';
import { BillingController, BillingService, PlatformController, PlatformService } from './billing/billing.service';
import { AllExceptionsFilter, ObservabilityController, requestObserver } from './observability/observability';
import { LookupController, LookupService } from './lookup/lookup.service';
import { BrandingController, BrandingService } from './branding/branding.service';
import { MediaController, ProductImagesController, ProductImagesService } from './catalog/product-images.service';
import { ProductQualityController, ProductQualityService } from './catalog/product-quality';
import { ChannelProductsController, ChannelProductsService } from './integrations/channel-products.service';
import { BankService } from './finance/bank.service';
import { FinanceController } from './finance/finance.controller';
import { FinanceService } from './finance/finance.service';
import { MarketplaceFinanceService } from './finance/marketplace-finance.service';
import { StatementsService } from './finance/statements.service';
import { LogisticsController } from './logistics/logistics.controller';
import { LogisticsService } from './logistics/logistics.service';
import { OrdersDashboardController, OrdersDashboardService } from './sales/orders-dashboard';
import { DelinquencyController, DelinquencyService } from './finance/delinquency';
import { NegotiationsController, NegotiationsService } from './finance/negotiations';
import { ManagementController, ManagementService } from './management/management';
import { CreditController, CreditService, ShelfLifeService } from './finance/credit';
import { QuotesController, QuotesService } from './sales/quotes';
import { WarehouseController, WarehouseService } from './stock/warehouse';
import { SmartPurchasingController, SmartPurchasingService } from './purchasing/smart';
import { FleetController, FleetService } from './delivery/fleet';
import { DeliveryController } from './delivery/delivery.controller';
import { DeliveryService } from './delivery/delivery.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { UsersController, UsersService } from './users/users.service';

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok', app: getConfig().appName };
  }
}

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({ global: true, secret: getConfig().jwtSecret, signOptions: { algorithm: 'HS256' }, verifyOptions: { algorithms: ['HS256'] } }),
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 300 }],
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
  ],
  controllers: [HealthController, AuthController, StructureController, UsersController, AuditController, CatalogController, StockController, CustomersController, SalesController, SmartPurchasingController, PurchasingController, SettingsController, IntegrationsController, WebhooksController, FiscalController, FinanceController, ReportsController, DeliveryController, DelinquencyController, NegotiationsController, ManagementController, CreditController, QuotesController, WarehouseController, FleetController, OrdersDashboardController, LogisticsController, BillingController, PlatformController, ObservabilityController, LookupController, BrandingController, ProductImagesController, MediaController, ProductQualityController, ChannelProductsController],
  providers: [
    AuthService,
    StructureService,
    UsersService,
    AuditService,
    CatalogService,
    StockService,
    CustomersService,
    SettingsService,
    CommissionsService,
    SalesService,
    PurchasingService,
    CryptoService,
    ConnectorRegistry,
    JobQueue,
    ConnectionsService,
    JobWorker,
    WebhooksService,
    OrderImportService,
    ChannelCatalogService,
    FiscalConfigService,
    FiscalInboundService,
    FiscalOutgoingService,
    TaxRulesService,
    FinanceService,
    BankService,
    StatementsService,
    MarketplaceFinanceService,
    ReportsService,
    DeliveryService,
    DelinquencyService,
    NegotiationsService,
    ManagementService,
    CreditService,
    ShelfLifeService,
    QuotesService,
    WarehouseService,
    SmartPurchasingService,
    FleetService,
    OrdersDashboardService,
    LogisticsService,
    BillingService,
    LookupService,
    BrandingService,
    ProductImagesService,
    ProductQualityService,
    ChannelProductsService,
    PlatformService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Provedor de transmissão: enquanto não houver implementação real, nenhuma emissão é simulada.
    // O provedor é escolhido por estabelecimento (cada empresa usa a própria conta); sem credencial, nada é transmitido nem simulado.
    { provide: FISCAL_PROVIDER, useClass: FiscalProviderRouter },
    ProviderContextService,
    IbgeService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

/** Configuração compartilhada entre main.ts e os testes e2e. */
export function configureApp(app: INestApplication): void {
  // Importação de planilhas envia o CSV no corpo JSON (até 5 MB).
  (app as unknown as { useBodyParser?: (t: string, o: object) => void }).useBodyParser?.('json', {
    limit: '6mb',
    // Webhooks precisam do corpo bruto para validar a assinatura.
    verify: (req: { rawBody?: Buffer }, _res: unknown, buf: Buffer) => { req.rawBody = buf; },
  });
  app.setGlobalPrefix('api');
  app.use(requestObserver);
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
