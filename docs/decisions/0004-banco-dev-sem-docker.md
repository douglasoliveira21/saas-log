# ADR-0004 — PostgreSQL de desenvolvimento sem Docker
O ambiente não tinha Docker, mas tinha binários do PostgreSQL. `scripts/dev-db.mjs` cria um cluster isolado em `.data/pg` (porta 5439, auth trust — somente local). Docker/compose entra na Fase 8 (DEPLOYMENT.md).
