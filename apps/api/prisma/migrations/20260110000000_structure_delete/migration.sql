-- Exclusão de cadastros estruturais criados por engano. A segurança vem das chaves estrangeiras RESTRICT (nada com
-- movimentação/vínculo é apagado) e das verificações da aplicação; a exclusão é auditada com o retrato do registro.
GRANT DELETE ON companies, establishments, warehouses TO dh_app;
-- Configuração fiscal ainda em rascunho (criada ao abrir a tela fiscal) precisa sair junto com o estabelecimento.
GRANT DELETE ON fiscal_configurations TO dh_app;
