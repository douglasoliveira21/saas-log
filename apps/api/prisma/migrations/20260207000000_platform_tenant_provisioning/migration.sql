-- Registra de forma privilegiada o provisionamento feito exclusivamente pelo administrador global.
CREATE OR REPLACE FUNCTION platform_record_tenant_created(p_tenant uuid, p_owner_email text, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant record; v_sub text;
BEGIN
  PERFORM platform_require();
  SELECT * INTO v_tenant FROM tenants WHERE id = p_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE = 'P0002'; END IF;
  v_sub := CASE v_tenant.status::text WHEN 'ACTIVE' THEN 'ACTIVE' ELSE 'TRIALING' END;
  INSERT INTO subscriptions (id, tenant_id, plan_id, status, note)
    VALUES (gen_random_uuid(), p_tenant, v_tenant.plan_id, v_sub, p_note);
  INSERT INTO platform_audit_log (actor_user_id, action, tenant_id, metadata)
    VALUES (app_user_id(), 'platform.tenant_created', p_tenant,
            jsonb_build_object('name', v_tenant.name, 'status', v_tenant.status, 'ownerEmail', p_owner_email, 'note', p_note));
END $$;

REVOKE ALL ON FUNCTION platform_record_tenant_created(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_record_tenant_created(uuid,text,text) TO dh_app;
