-- Rotas de entrega, paradas e comprovantes (canhotos): isolados por RLS.
GRANT SELECT, INSERT, UPDATE ON drivers, delivery_routes, delivery_stops TO dh_app;
GRANT SELECT, INSERT ON delivery_proofs TO dh_app; -- o comprovante é imutável: sem UPDATE nem DELETE

ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;         ALTER TABLE drivers FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_routes ENABLE ROW LEVEL SECURITY; ALTER TABLE delivery_routes FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_stops ENABLE ROW LEVEL SECURITY;  ALTER TABLE delivery_stops FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery_proofs ENABLE ROW LEVEL SECURITY; ALTER TABLE delivery_proofs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON drivers TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON delivery_routes TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON delivery_stops TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON delivery_proofs TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE delivery_routes ADD CONSTRAINT delivery_routes_status_valid CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_status_valid CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'CANCELLED'));
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_sequence_valid CHECK (sequence >= 1);
-- Uma entrega só pode estar pendente em UMA rota por vez (vale mesmo com cliques simultâneos).
CREATE UNIQUE INDEX delivery_stops_one_pending_per_order ON delivery_stops (tenant_id, sales_order_id) WHERE status = 'PENDING';
-- Entregue exige o comprovante: o recebedor e a data ficam preenchidos.
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_delivered_data CHECK (status <> 'DELIVERED' OR (delivered_at IS NOT NULL AND receiver_name IS NOT NULL));
ALTER TABLE delivery_stops ADD CONSTRAINT delivery_stops_failed_reason CHECK (status <> 'FAILED' OR failure_reason IS NOT NULL);
ALTER TABLE delivery_proofs ADD CONSTRAINT delivery_proofs_kind_valid CHECK (kind IN ('DELIVERY', 'FAILURE'));
ALTER TABLE delivery_proofs ADD CONSTRAINT delivery_proofs_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE delivery_proofs ADD CONSTRAINT delivery_proofs_size CHECK (bytes BETWEEN 2000 AND 5242880 AND octet_length(content) = bytes);
ALTER TABLE delivery_proofs ADD CONSTRAINT delivery_proofs_dims CHECK (width BETWEEN 1 AND 12000 AND height BETWEEN 1 AND 12000);
