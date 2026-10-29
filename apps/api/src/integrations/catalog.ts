import { BaseConnector, CapabilityMatrix, ConnectorInfo } from './connector';

export type ChannelCategory = 'MARKETPLACE' | 'STORE_PLATFORM' | 'HUB';

const PLANNED: CapabilityMatrix = {
  authorization: 'PLANNED', orders: 'PLANNED', catalog: 'PLANNED', publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED', shipments: 'PLANNED', webhooks: 'PLANNED',
};

const AUTH_NOTE = 'Forma de autenticação conforme a documentação pública; confirme na documentação vigente antes de implementar.';

/**
 * Catálogo de canais PLANEJADOS. A ESTRUTURA existe (cadastro da conexão, estados, credenciais cifradas, fila, webhooks, logs), mas
 * nenhum destes conectores implementa chamada alguma ao canal: todas as operações devolvem NOT_IMPLEMENTED e a matriz de
 * capacidades é "PLANNED" — nunca "SUPPORTED". Implementar cada um depende de (1) ler a documentação oficial vigente,
 * (2) credenciais/aprovação do aplicativo pelo canal e (3) testes em sandbox ou conta real.
 * Endereços de documentação foram conferidos como acessíveis em 20/10/2026; vazio = não localizado publicamente.
 */
export const PLANNED_CHANNELS: ConnectorInfo[] = [
  { provider: 'SHOPEE', displayName: 'Shopee', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'SIGNED_OAUTH2', docsUrl: 'https://open.shopee.com/',
    notes: 'Requer conta no Shopee Open Platform e aplicativo aprovado; a documentação vigente deve ser confirmada antes da implementação.' },
  { provider: 'AMERICANAS', displayName: 'Americanas', category: 'MARKETPLACE', region: 'BR', authType: 'API_KEY', docsUrl: '',
    notes: 'Documentação pública não localizada nesta revisão: consulte o canal ou um integrador homologado (ex.: Anymarket, Bling).' },
  { provider: 'CASAS_BAHIA', displayName: 'Casas Bahia / Ponto', category: 'MARKETPLACE', region: 'BR', authType: 'API_KEY', docsUrl: '',
    notes: 'Documentação pública não localizada nesta revisão: consulte o canal ou um integrador homologado (ex.: Anymarket, Bling).' },
  { provider: 'TIKTOK_SHOP', displayName: 'TikTok Shop', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'SIGNED_OAUTH2', docsUrl: 'https://partner.tiktokshop.com/docv2',
    notes: `Requer cadastro no Partner Center e aplicativo aprovado. A disponibilidade por país deve ser confirmada. ${AUTH_NOTE}` },
  { provider: 'ALIEXPRESS', displayName: 'AliExpress', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'SIGNED_OAUTH2', docsUrl: 'https://openservice.aliexpress.com/',
    notes: `Plataforma aberta do AliExpress; requer aplicativo aprovado. ${AUTH_NOTE}` },
  { provider: 'OLX', displayName: 'OLX', category: 'MARKETPLACE', region: 'BR', authType: 'OAUTH2', docsUrl: 'https://developers.olx.com.br/',
    notes: `Classificados: o modelo de pedido difere de um marketplace tradicional (negociação direta). ${AUTH_NOTE}` },
  { provider: 'EBAY', displayName: 'eBay', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'OAUTH2', docsUrl: 'https://developer.ebay.com/',
    notes: `Requer conta de desenvolvedor eBay e chaves de aplicativo. ${AUTH_NOTE}` },
  { provider: 'ETSY', displayName: 'Etsy', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'OAUTH2', docsUrl: 'https://developers.etsy.com/',
    notes: `Requer aplicativo aprovado no portal de desenvolvedores. ${AUTH_NOTE}` },
  { provider: 'WALMART', displayName: 'Walmart Marketplace', category: 'MARKETPLACE', region: 'GLOBAL', authType: 'OAUTH2', docsUrl: 'https://developer.walmart.com/',
    notes: `Foco em vendedores dos EUA/Canadá/México. ${AUTH_NOTE}` },

  { provider: 'SHOPIFY', displayName: 'Shopify', category: 'STORE_PLATFORM', region: 'GLOBAL', authType: 'OAUTH2', docsUrl: 'https://shopify.dev/docs',
    notes: `Loja própria: pedidos, estoque e preços. Requer aplicativo (custom app) na loja. ${AUTH_NOTE}` },
  { provider: 'WOOCOMMERCE', displayName: 'WooCommerce', category: 'STORE_PLATFORM', region: 'GLOBAL', authType: 'API_KEY', docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    notes: `Loja própria em WordPress: chaves da API REST geradas pelo administrador da loja. ${AUTH_NOTE}` },
  { provider: 'VTEX', displayName: 'VTEX', category: 'STORE_PLATFORM', region: 'BR', authType: 'API_KEY', docsUrl: 'https://developers.vtex.com/',
    notes: `Loja própria: chave e token de aplicação criados no painel VTEX. ${AUTH_NOTE}` },
  { provider: 'NUVEMSHOP', displayName: 'Nuvemshop', category: 'STORE_PLATFORM', region: 'BR', authType: 'OAUTH2', docsUrl: 'https://nuvemshop.dev/',
    notes: `Loja própria. Requer aplicativo de parceiro. ${AUTH_NOTE}` },
  { provider: 'TRAY', displayName: 'Tray', category: 'STORE_PLATFORM', region: 'BR', authType: 'OAUTH2', docsUrl: 'https://developers.tray.com.br/',
    notes: `Loja própria. Requer aplicativo cadastrado como parceiro. ${AUTH_NOTE}` },

  { provider: 'BLING', displayName: 'Bling', category: 'HUB', region: 'BR', authType: 'OAUTH2', docsUrl: 'https://developer.bling.com.br/home',
    notes: `ERP/integrador: uma conexão pode alcançar vários marketplaces já ligados ao Bling. ${AUTH_NOTE}` },
  { provider: 'ANYMARKET', displayName: 'Anymarket', category: 'HUB', region: 'BR', authType: 'API_KEY', docsUrl: 'https://api.anymarket.com.br/',
    notes: `Integrador de marketplaces: uma conexão alcança vários canais. ${AUTH_NOTE}` },
  { provider: 'MIRAKL', displayName: 'Mirakl (marketplaces corporativos)', category: 'HUB', region: 'GLOBAL', authType: 'API_KEY', docsUrl: 'https://developer.mirakl.com/',
    notes: `Plataforma usada por vários marketplaces de grandes varejistas; cada operador libera a chave de API ao seller. ${AUTH_NOTE}` },
];

export class PlannedConnector extends BaseConnector {
  constructor(readonly info: ConnectorInfo) { super(); }
  getCapabilities() { return PLANNED; }
}
