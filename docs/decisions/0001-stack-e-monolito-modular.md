# ADR-0001 — Monólito modular com NestJS, Prisma, PostgreSQL e Next.js
Contexto: diretório vazio, equipe pequena, domínio com forte consistência transacional (estoque/fiscal/financeiro).
Decisão: monólito modular NestJS 11 + Prisma 6.19 (não o 8.0 RC, que é o `latest` do npm) + PostgreSQL; frontend Next.js 16/React 19. Redis/BullMQ só quando houver trabalho assíncrono (Fase 4).
Consequências: fácil de evoluir; microserviços só se houver necessidade real.
