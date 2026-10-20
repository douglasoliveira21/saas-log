-- Corrige o tipo do COALESCE em platform_update_tenant (enum × texto).
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
  UPDATE tenants SET status = COALESCE(p_status, status::text)::"TenantStatus", plan_id = COALESCE(v_plan, plan_id), trial_ends_at = COALESCE(p_trial_ends, trial_ends_at)
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
