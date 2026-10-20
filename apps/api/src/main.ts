import 'reflect-metadata';
import { loadEnv } from './config/app.config';

loadEnv();

async function bootstrap() {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule, configureApp } = await import('./app.module');
  const { getConfig } = await import('./config/app.config');
  const app = await NestFactory.create<import('@nestjs/platform-express').NestExpressApplication>(AppModule);
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  configureApp(app);
  const cfg = getConfig();
  await app.listen(cfg.port);
  console.log(`${cfg.appName} API em http://localhost:${cfg.port}/api`);
}

void bootstrap();
