import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export interface DbContext {
  tenantId?: string | null;
  userId?: string | null;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Única porta de entrada para tabelas protegidas por RLS: abre uma transação, define
   * app.tenant_id / app.user_id (válidos só nela) e executa `fn`. Fora daqui, consultas
   * a tabelas com RLS retornam vazio — falha segura.
   * Nunca chame APIs externas dentro de `fn` (transação aberta).
   */
  async withContext<T>(ctx: DbContext, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${ctx.tenantId ?? ''}, true), set_config('app.user_id', ${ctx.userId ?? ''}, true)`;
        return fn(tx);
      },
      { timeout: 15000, maxWait: 5000 },
    );
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
