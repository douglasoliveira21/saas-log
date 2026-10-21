-- Fotos de produto e itens do canal: isolados por RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_images TO dh_app;
GRANT SELECT, INSERT, UPDATE ON channel_items TO dh_app;

ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;  ALTER TABLE product_images FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_items ENABLE ROW LEVEL SECURITY;   ALTER TABLE channel_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON product_images TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON channel_items TO dh_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE product_images ADD CONSTRAINT product_images_size CHECK (bytes BETWEEN 100 AND 3145728 AND octet_length(content) = bytes);
ALTER TABLE product_images ADD CONSTRAINT product_images_type CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp'));
ALTER TABLE product_images ADD CONSTRAINT product_images_dims CHECK (width BETWEEN 1 AND 10000 AND height BETWEEN 1 AND 10000);
ALTER TABLE product_images ADD CONSTRAINT product_images_pos CHECK (position BETWEEN 0 AND 11);
ALTER TABLE channel_items ADD CONSTRAINT channel_items_status_valid CHECK (status IN ('NEW', 'LINKED', 'IMPORTED', 'IGNORED'));

-- Entrega PÚBLICA de uma foto para o marketplace baixá-la (a assinatura temporária é validada pela aplicação).
-- Função estreita: devolve só tipo e bytes de UMA imagem por id; sem assinatura válida a aplicação nem a chama.
CREATE OR REPLACE FUNCTION media_image(p_id uuid)
RETURNS TABLE (content_type text, content bytea)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.content_type, i.content FROM product_images i WHERE i.id = p_id;
$$;
REVOKE ALL ON FUNCTION media_image(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_image(uuid) TO dh_app;
