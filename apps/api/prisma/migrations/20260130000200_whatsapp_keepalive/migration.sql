-- AlterTable
ALTER TABLE "whatsapp_connections" ADD COLUMN     "want_connected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconnect_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "lost_notified_at" TIMESTAMP(3);

-- Vigia da sessão: quais empresas querem o WhatsApp sempre ligado (só ids; o resto é lido com o contexto da empresa).
CREATE FUNCTION list_whatsapp_tenants() RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tenant_id FROM whatsapp_connections WHERE want_connected
$$;
REVOKE ALL ON FUNCTION list_whatsapp_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_whatsapp_tenants() TO dh_app;
