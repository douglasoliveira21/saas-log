-- Prisma grava timestamps sem fuso como UTC; defaults now() do banco seguem o fuso da sessão.
-- Sessões do papel de runtime em UTC mantêm tudo consistente (comparações run_at <= now(), etc.).
ALTER ROLE dh_app SET timezone TO 'UTC';
