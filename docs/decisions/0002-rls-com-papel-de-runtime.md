# ADR-0002 — Isolamento por RLS com papel de runtime dedicado
Decisão: o app conecta como `dh_app` (sem BYPASSRLS, não dono); contexto via `set_config(..., true)` dentro de transação; políticas `tenant_id = app_tenant_id()`; FKs compostas por tenant; migrações pelo papel dono (`DIRECT_URL`).
Alternativas descartadas: apenas filtros na aplicação (um esquecimento vaza dados); schema/banco por tenant (custo operacional alto nesta etapa).
Custo: toda consulta passa por `withContext`; transações curtas, sem chamadas externas dentro delas.
