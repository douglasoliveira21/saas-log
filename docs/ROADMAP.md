# Roadmap

| Fase | Escopo | Estado |
|---|---|---|
| 1 | Fundação: auth, tenants, RLS, RBAC, auditoria, empresa/estabelecimento/depósito, layout | **Concluída** (ver TESTING.md) |
| 2 | Produtos, categorias, fornecedores, estoque (saldos, reservas, movimentações, inventário), importação por planilha | **Concluída** (ver INVENTORY.md; pendências listadas lá) |
| 3 | Compras, vendas, clientes, devoluções, vendedores e comissões | **Concluída** (ver COMMERCIAL.md; pendências listadas lá) |
| 4 | Infra de integrações: conexões, conectores, credenciais cifradas, fila (PostgreSQL, ADR-0006), webhooks, idempotência, logs e monitoramento | **Concluída** (infra; sem conector real — ver MARKETPLACE-INTEGRATIONS.md) |
| 5 | Marketplaces (primeiro canal real validado antes de replicar) | **Em andamento** — Mercado Livre: OAuth + importação de pedidos implementados e testados com servidor simulado; **falta validar com conta real**. **Feito sem credenciais:** anúncios, preço aprovado com proteções, simulador de margem, estoque publicável, categorias e sincronização (testados com o conector Sandbox). Pendentes: envio real de preço/estoque/publicação no Mercado Livre, envios, conciliação; Amazon e Shopee |
| 6 | Fiscal: assistente, XML recebidos, motor fiscal versionado, NF-e em homologação | **Concluída na parte que independe de contador/certificado** (ver FISCAL-BRAZIL.md). **Pendentes:** XML/assinatura/transmissão (provedor), eventos (cancelamento, CC-e, inutilização), verificação de autenticidade, ST/DIFAL/FCP, IBS/CBS, validação com o contador e testes em homologação real |
| 7 | Financeiro (pagar/receber, duplicatas do XML, comissões), conciliação bancária e de marketplaces, fluxo de caixa, DRE gerencial, relatórios com exportação, expedição/Correios | **Concluída no que independe de credenciais** (ver FINANCE.md). **Pendentes:** Correios (cotação/etiqueta/rastreio automático), liquidações via API dos canais, boletos/CNAB, cartão/adquirente, rateio e orçamento |
| 8 | Planos/assinaturas, administrador global, backup/restore testado, observabilidade, revisão de segurança, documentação de implantação | **Concluída no que é possível sem terceiros** (ver PLATFORM.md, DEPLOYMENT.md, SECURITY-REVIEW.md). **Pendentes:** gateway de pagamento, MFA/e-mail transacional, LGPD (titulares/retenção), CI, HTTPS/monitoramento externo, teste dos Dockerfiles, pentest independente |

Pendências transversais da Fase 1: MFA, e-mails transacionais, Docker/CI, assistente de implantação guiada (hoje só há checklist na visão geral), busca global, tema manual, testes de UI.
