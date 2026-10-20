-- Fase 8: planos, assinaturas e administração da plataforma.
-- O papel de runtime (dh_app) continua sem BYPASSRLS. O administrador da plataforma NÃO lê dados de negócio dos tenants:
-- só metadados agregados, por funções estreitas (SECURITY DEFINER) que exigem app.user_id ∈ platform_admins.

GRANT SELECT ON subscriptions TO dh_app;               -- escrita somente via platform_update_tenant
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions FOR SELECT TO dh_app USING (tenant_id = app_tenant_id());

-- Sem acesso direto do runtime a estas tabelas.
REVOKE ALL ON platform_admins, platform_audit_log FROM dh_app;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;      ALTER TABLE platform_admins FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;   ALTER TABLE platform_audit_log FORCE ROW LEVEL SECURITY;

ALTER TABLE plans ADD CONSTRAINT plans_price_nonneg CHECK (price_cents IS NULL OR price_cents >= 0);
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_valid CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED','SUSPENDED'));

CREATE OR REPLACE FUNCTION platform_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = app_user_id()
                 AND EXISTS (SELECT 1 FROM users u WHERE u.id = platform_admins.user_id AND u.status = 'ACTIVE'));
$$;

CREATE OR REPLACE FUNCTION platform_require() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT platform_is_admin() THEN RAISE EXCEPTION 'platform_forbidden' USING ERRCODE = '42501'; END IF;
END $$;

-- Visão geral: somente metadados e contagens (nada de dados comerciais, fiscais ou financeiros).
CREATE OR REPLACE FUNCTION platform_list_tenants()
RETURNS TABLE (id uuid, name text, slug text, status text, plan_code text, trial_ends_at timestamp, created_at timestamp,
               users bigint, products bigint, orders_30d bigint, connections bigint, last_activity timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM platform_require();
  RETURN QUERY
  SELECT t.id, t.name, t.slug, t.status::text, p.code, t.trial_ends_at, t.created_at,
         (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'ACTIVE'),
         (SELECT count(*) FROM products x WHERE x.tenant_id = t.id),
         (SELECT count(*) FROM sales_orders o WHERE o.tenant_id = t.id AND o.created_at > now() - interval '30 days'),
         (SELECT count(*) FROM marketplace_connections c WHERE c.tenant_id = t.id AND c.status <> 'DISCONNECTED'),
         (SELECT max(a.created_at) FROM audit_logs a WHERE a.tenant_id = t.id)
  FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id ORDER BY t.created_at DESC;
END $$;

CREATE OR REPLACE FUNCTION platform_update_tenant(p_tenant uuid, p_status text, p_plan_code text, p_trial_ends timestamp, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_plan uuid; v_old record; v_sub text;
BEGIN
  PERFORM platform_require();
  SELECT * INTO v_old FROM tenants WHERE id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002'; END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('TRIAL','ACTIVE','SUSPENDED') THEN RAISE EXCEPTION 'invalid_status' USING ERRCODE = '22023'; END IF;
  IF p_plan_code IS NOT NULL THEN
    SELECT id INTO v_plan FROM plans WHERE code = p_plan_code AND active;
    IF v_plan IS NULL THEN RAISE EXCEPTION 'invalid_plan' USING ERRCODE = '22023'; END IF;
  END IF;
  UPDATE tenants SET status = COALESCE(p_status, status)::"TenantStatus", plan_id = COALESCE(v_plan, plan_id), trial_ends_at = COALESCE(p_trial_ends, trial_ends_at)
   WHERE id = p_tenant;
  v_sub := CASE COALESCE(p_status, v_old.status::text) WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'SUSPENDED' THEN 'SUSPENDED' ELSE 'TRIALING' END;
  INSERT INTO subscriptions (id, tenant_id, plan_id, status, note)
    VALUES (gen_random_uuid(), p_tenant, COALESCE(v_plan, v_old.plan_id), v_sub, p_note)
    ON CONFLICT DO NOTHING;
  INSERT INTO platform_audit_log (actor_user_id, action, tenant_id, metadata)
    VALUES (app_user_id(), 'platform.tenant_updated', p_tenant,
            jsonb_build_object('fromStatus', v_old.status, 'toStatus', COALESCE(p_status, v_old.status::text), 'plan', p_plan_code, 'trialEnds', p_trial_ends, 'note', p_note));
  -- transparência: o tenant vê a alteração na própria auditoria
  INSERT INTO audit_logs (tenant_id, user_id, action, entity, entity_id, metadata)
    VALUES (p_tenant, app_user_id(), 'platform.subscription_changed', 'tenant', p_tenant::text,
            jsonb_build_object('status', COALESCE(p_status, v_old.status::text), 'plan', p_plan_code, 'note', p_note));
END $$;

CREATE OR REPLACE FUNCTION platform_upsert_plan(p_code text, p_name text, p_limits jsonb, p_price_cents integer, p_description text, p_active boolean, p_sort integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM platform_require();
  IF p_code !~ '^[a-z0-9_-]{2,40}$' THEN RAISE EXCEPTION 'invalid_code' USING ERRCODE = '22023'; END IF;
  INSERT INTO plans (id, code, name, limits, price_cents, description, active, sort_order)
    VALUES (gen_random_uuid(), p_code, p_name, p_limits, p_price_cents, p_description, p_active, p_sort)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, limits = EXCLUDED.limits, price_cents = EXCLUDED.price_cents,
      description = EXCLUDED.description, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order
    RETURNING id INTO v_id;
  INSERT INTO platform_audit_log (actor_user_id, action, metadata) VALUES (app_user_id(), 'platform.plan_saved', jsonb_build_object('code', p_code, 'limits', p_limits, 'priceCents', p_price_cents, 'active', p_active));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION platform_audit(p_limit integer)
RETURNS TABLE (id bigint, actor_user_id uuid, action text, tenant_id uuid, metadata jsonb, created_at timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM platform_require();
  RETURN QUERY SELECT l.id, l.actor_user_id, l.action, l.tenant_id, l.metadata, l.created_at FROM platform_audit_log l ORDER BY l.id DESC LIMIT LEAST(GREATEST(p_limit, 1), 500);
END $$;

-- Métricas operacionais globais (filas), sem conteúdo.
CREATE OR REPLACE FUNCTION platform_queue_stats()
RETURNS TABLE (status text, jobs bigint, oldest_ready timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT j.status::text, count(*), min(j.run_at) FROM background_jobs j GROUP BY j.status;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['platform_is_admin()', 'platform_require()', 'platform_list_tenants()', 'platform_update_tenant(uuid,text,text,timestamp,text)',
                           'platform_upsert_plan(text,text,jsonb,integer,text,boolean,integer)', 'platform_audit(integer)', 'platform_queue_stats()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dh_app', f);
  END LOOP;
END $$;

-- Catálogo de planos. Limites ausentes = ilimitado. Preços NÃO são definidos aqui (decisão comercial): price_cents fica nulo.
UPDATE plans SET limits = '{"users":5,"establishments":2,"warehouses":3,"products":500,"connections":1,"ordersPerMonth":300}', sort_order = 0,
  description = 'Avaliação de 14 dias; ao expirar, o sistema fica somente leitura.' WHERE code = 'trial';
INSERT INTO plans (id, code, name, limits, active, sort_order, description) VALUES
  (gen_random_uuid(), 'starter', 'Starter', '{"users":5,"establishments":2,"warehouses":3,"products":2000,"connections":2,"ordersPerMonth":1000}', true, 10, 'Limites iniciais sugeridos; preço a definir.'),
  (gen_random_uuid(), 'pro', 'Pro', '{"users":20,"establishments":5,"warehouses":10,"products":20000,"connections":6,"ordersPerMonth":10000}', true, 20, 'Limites iniciais sugeridos; preço a definir.'),
  (gen_random_uuid(), 'enterprise', 'Enterprise', '{}', true, 30, 'Sem limites de uso; condições sob contrato.')
ON CONFLICT (code) DO NOTHING;
