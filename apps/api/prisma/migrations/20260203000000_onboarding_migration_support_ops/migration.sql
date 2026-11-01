-- Onboarding, migração assistida, suporte temporário e observabilidade operacional.

CREATE TABLE migration_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  entity text NOT NULL,
  file_name text,
  dry_run boolean NOT NULL DEFAULT true,
  status text NOT NULL,
  total_rows integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  created_by_id uuid,
  created_at timestamp(3) NOT NULL DEFAULT current_timestamp
);
CREATE UNIQUE INDEX migration_runs_tenant_id_id_key ON migration_runs(tenant_id, id);
CREATE INDEX migration_runs_tenant_id_created_at_idx ON migration_runs(tenant_id, created_at);

CREATE TABLE legacy_import_records (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  external_id text NOT NULL,
  kind text NOT NULL,
  occurred_at timestamp(3),
  description text,
  amount decimal(14,2),
  payload jsonb NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT current_timestamp
);
CREATE UNIQUE INDEX legacy_import_records_tenant_id_kind_external_id_key ON legacy_import_records(tenant_id, kind, external_id);
CREATE INDEX legacy_import_records_tenant_id_occurred_at_idx ON legacy_import_records(tenant_id, occurred_at);

GRANT SELECT, INSERT ON migration_runs, legacy_import_records TO dh_app;
GRANT UPDATE ON migration_runs TO dh_app;
ALTER TABLE migration_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE legacy_import_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE legacy_import_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON migration_runs TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON legacy_import_records TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE migration_runs ADD CONSTRAINT migration_runs_status_valid CHECK (status IN ('VALIDATED','COMPLETED','FAILED'));
ALTER TABLE migration_runs ADD CONSTRAINT migration_runs_entity_valid CHECK (entity IN ('PRODUCTS','CUSTOMERS','SUPPLIERS','STOCK','OPEN_TITLES','HISTORY'));

-- Global e inacessível diretamente. As funções abaixo são a única porta de entrada.
CREATE TABLE support_access_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  requested_by_id uuid NOT NULL REFERENCES users(id),
  approved_by_id uuid REFERENCES users(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'REQUESTED',
  allow_write boolean NOT NULL DEFAULT false,
  requested_minutes integer NOT NULL DEFAULT 30,
  expires_at timestamp(3),
  created_at timestamp(3) NOT NULL DEFAULT current_timestamp,
  decided_at timestamp(3),
  revoked_at timestamp(3)
);
CREATE INDEX support_access_sessions_tenant_id_status_idx ON support_access_sessions(tenant_id, status);
CREATE INDEX support_access_sessions_requested_by_id_status_idx ON support_access_sessions(requested_by_id, status);
ALTER TABLE support_access_sessions ADD CONSTRAINT support_status_valid CHECK (status IN ('REQUESTED','APPROVED','DENIED','REVOKED','EXPIRED'));
ALTER TABLE support_access_sessions ADD CONSTRAINT support_minutes_valid CHECK (requested_minutes BETWEEN 5 AND 120);
REVOKE ALL ON support_access_sessions FROM dh_app;
ALTER TABLE support_access_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_access_sessions FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION platform_support_request(p_tenant uuid, p_reason text, p_minutes integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  PERFORM platform_require();
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN RAISE EXCEPTION 'tenant_not_found'; END IF;
  IF length(trim(p_reason)) < 10 OR p_minutes NOT BETWEEN 5 AND 120 THEN RAISE EXCEPTION 'invalid_support_request'; END IF;
  INSERT INTO support_access_sessions(id, tenant_id, requested_by_id, reason, requested_minutes)
    VALUES(v_id, p_tenant, app_user_id(), trim(p_reason), p_minutes);
  INSERT INTO platform_audit_log(actor_user_id, action, tenant_id, metadata)
    VALUES(app_user_id(), 'platform.support_requested', p_tenant, jsonb_build_object('sessionId',v_id,'reason',p_reason,'minutes',p_minutes));
  INSERT INTO audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(p_tenant,app_user_id(),'support.requested','support_session',v_id::text,jsonb_build_object('reason',p_reason,'minutes',p_minutes));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION tenant_support_sessions()
RETURNS TABLE(id uuid, requested_by uuid, requester text, reason text, status text, allow_write boolean, requested_minutes integer, expires_at timestamp, created_at timestamp)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_tenant_id() IS NULL THEN RAISE EXCEPTION 'tenant_required'; END IF;
  RETURN QUERY SELECT s.id,s.requested_by_id,u.name,s.reason,s.status,s.allow_write,s.requested_minutes,s.expires_at,s.created_at
    FROM support_access_sessions s JOIN users u ON u.id=s.requested_by_id
    WHERE s.tenant_id=app_tenant_id() ORDER BY s.created_at DESC LIMIT 50;
END $$;

CREATE OR REPLACE FUNCTION tenant_support_decide(p_id uuid, p_approve boolean, p_minutes integer, p_allow_write boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_role text;
BEGIN
  v_tenant := app_tenant_id();
  SELECT r.key INTO v_role FROM memberships m JOIN roles r ON r.id=m.role_id AND r.tenant_id=m.tenant_id
    WHERE m.tenant_id=v_tenant AND m.user_id=app_user_id() AND m.status='ACTIVE';
  IF v_role <> 'owner' THEN RAISE EXCEPTION 'support_owner_required' USING ERRCODE='42501'; END IF;
  IF p_minutes NOT BETWEEN 5 AND 120 THEN RAISE EXCEPTION 'invalid_support_duration'; END IF;
  UPDATE support_access_sessions SET status=CASE WHEN p_approve THEN 'APPROVED' ELSE 'DENIED' END,
    approved_by_id=app_user_id(),allow_write=CASE WHEN p_approve THEN p_allow_write ELSE false END,
    expires_at=CASE WHEN p_approve THEN now()+make_interval(mins=>p_minutes) ELSE NULL END,decided_at=now()
    WHERE id=p_id AND tenant_id=v_tenant AND status='REQUESTED';
  IF NOT FOUND THEN RAISE EXCEPTION 'support_request_not_found'; END IF;
  INSERT INTO audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    VALUES(v_tenant,app_user_id(),CASE WHEN p_approve THEN 'support.approved' ELSE 'support.denied' END,'support_session',p_id::text,
      jsonb_build_object('minutes',p_minutes,'allowWrite',p_allow_write));
END $$;

CREATE OR REPLACE FUNCTION tenant_support_revoke(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE support_access_sessions SET status='REVOKED',revoked_at=now()
    WHERE id=p_id AND tenant_id=app_tenant_id() AND status='APPROVED';
  IF NOT FOUND THEN RAISE EXCEPTION 'support_session_not_found'; END IF;
  INSERT INTO audit_logs(tenant_id,user_id,action,entity,entity_id) VALUES(app_tenant_id(),app_user_id(),'support.revoked','support_session',p_id::text);
END $$;

CREATE OR REPLACE FUNCTION platform_support_sessions()
RETURNS TABLE(id uuid, tenant_id uuid, tenant_name text, requested_by uuid, requester text, reason text, status text, allow_write boolean, expires_at timestamp, created_at timestamp)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM platform_require();
  UPDATE support_access_sessions SET status='EXPIRED' WHERE status='APPROVED' AND expires_at<=now();
  RETURN QUERY SELECT s.id,s.tenant_id,t.name,s.requested_by_id,u.name,s.reason,s.status,s.allow_write,s.expires_at,s.created_at
    FROM support_access_sessions s JOIN tenants t ON t.id=s.tenant_id JOIN users u ON u.id=s.requested_by_id
    ORDER BY s.created_at DESC LIMIT 100;
END $$;

CREATE OR REPLACE FUNCTION support_validate(p_id uuid, p_user uuid, p_tenant uuid)
RETURNS TABLE(ok boolean, allow_write boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT true,s.allow_write FROM support_access_sessions s
    WHERE s.id=p_id AND s.requested_by_id=p_user AND s.tenant_id=p_tenant AND s.status='APPROVED' AND s.expires_at>now()
      AND EXISTS(SELECT 1 FROM platform_admins a WHERE a.user_id=p_user);
END $$;

CREATE OR REPLACE FUNCTION platform_support_enter(p_id uuid)
RETURNS TABLE(tenant_id uuid, allow_write boolean, expires_at timestamp)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM platform_require();
  RETURN QUERY SELECT s.tenant_id,s.allow_write,s.expires_at FROM support_access_sessions s
    WHERE s.id=p_id AND s.requested_by_id=app_user_id() AND s.status='APPROVED' AND s.expires_at>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'support_session_inactive'; END IF;
  INSERT INTO platform_audit_log(actor_user_id,action,tenant_id,metadata)
    SELECT app_user_id(),'platform.support_entered',s.tenant_id,jsonb_build_object('sessionId',s.id,'allowWrite',s.allow_write) FROM support_access_sessions s WHERE s.id=p_id;
  INSERT INTO audit_logs(tenant_id,user_id,action,entity,entity_id,metadata)
    SELECT s.tenant_id,app_user_id(),'support.entered','support_session',s.id::text,jsonb_build_object('allowWrite',s.allow_write) FROM support_access_sessions s WHERE s.id=p_id;
END $$;

CREATE OR REPLACE FUNCTION platform_operations_overview()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE out jsonb;
BEGIN
  PERFORM platform_require();
  SELECT jsonb_build_object(
    'generatedAt',now(),
    'tenants',jsonb_build_object('total',(SELECT count(*) FROM tenants),'active',(SELECT count(*) FROM tenants WHERE status='ACTIVE'),'trial',(SELECT count(*) FROM tenants WHERE status='TRIAL'),'suspended',(SELECT count(*) FROM tenants WHERE status='SUSPENDED')),
    'jobs',COALESCE((SELECT jsonb_object_agg(status,c) FROM (SELECT status::text,count(*) c FROM background_jobs GROUP BY status) q),'{}'::jsonb),
    'deadJobs',(SELECT count(*) FROM background_jobs WHERE status='DEAD'),
    'staleJobs',(SELECT count(*) FROM background_jobs WHERE status='QUEUED' AND run_at<now()-interval '10 minutes'),
    'brokenConnections',(SELECT count(*) FROM marketplace_connections WHERE status='SYNC_ERROR'),
    'failedIntegrations24h',(SELECT count(*) FROM integration_logs WHERE level='ERROR' AND created_at>now()-interval '24 hours'),
    'failedNotifications24h',(SELECT count(*) FROM notification_logs WHERE status='FAILED' AND created_at>now()-interval '24 hours'),
    'recentErrors',COALESCE((SELECT jsonb_agg(x) FROM (SELECT l.tenant_id,t.name tenant,l.connection_id,l.operation action,l.status_code code,l.message,l.created_at FROM integration_logs l JOIN tenants t ON t.id=l.tenant_id WHERE l.level='ERROR' ORDER BY l.created_at DESC LIMIT 30) x),'[]'::jsonb),
    'tenantHealth',COALESCE((SELECT jsonb_agg(x) FROM (SELECT t.id,t.name,t.status::text,p.code plan,(SELECT count(*) FROM memberships m WHERE m.tenant_id=t.id AND m.status='ACTIVE') users,(SELECT count(*) FROM products pr WHERE pr.tenant_id=t.id) products,(SELECT count(*) FROM background_jobs j WHERE j.tenant_id=t.id AND j.status='DEAD') dead_jobs,(SELECT count(*) FROM marketplace_connections c WHERE c.tenant_id=t.id AND c.status='SYNC_ERROR') broken_connections,(SELECT max(a.created_at) FROM audit_logs a WHERE a.tenant_id=t.id) last_activity FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id ORDER BY t.created_at DESC LIMIT 200) x),'[]'::jsonb)
  ) INTO out;
  RETURN out;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_support_request(uuid,text,integer)','tenant_support_sessions()','tenant_support_decide(uuid,boolean,integer,boolean)',
    'tenant_support_revoke(uuid)','platform_support_sessions()','support_validate(uuid,uuid,uuid)',
    'platform_support_enter(uuid)','platform_operations_overview()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO dh_app',f);
  END LOOP;
END $$;
