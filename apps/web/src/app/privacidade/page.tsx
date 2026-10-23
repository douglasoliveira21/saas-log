import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/legal';
import { BRAND } from '@/lib/brand';
import { VGON } from '@/lib/company';

export const metadata: Metadata = { title: `Política de privacidade — ${BRAND.name}` };

const S: LegalSection[] = [
  {
    id: 'quem', title: 'Quem somos e quais são os nossos papéis',
    body: <>
      <p>Esta política explica como a <strong>{VGON.name}</strong> (CNPJ {VGON.cnpj}, “{VGON.short}”) trata dados pessoais no {BRAND.name}, em conformidade com a Lei Geral de Proteção de Dados (LGPD – Lei nº 13.709/2018).</p>
      <ul>
        <li><strong>Como controladora</strong>, a {VGON.short} decide sobre os dados de acesso e de uso dos Usuários da Plataforma (conta, login, segurança, suporte).</li>
        <li><strong>Como operadora</strong>, a {VGON.short} trata, em nome e conforme as instruções do Cliente (a empresa que contrata o sistema), os dados que o Cliente insere na Plataforma — por exemplo, cadastros de clientes finais, fornecedores, pedidos e documentos fiscais. Nesses casos, o Cliente é o controlador e responde pela base legal e pelas informações aos titulares.</li>
      </ul>
    </>,
  },
  {
    id: 'dados', title: 'Quais dados tratamos',
    body: <ul>
      <li><strong>Dados da conta do Usuário:</strong> nome, e-mail, telefone (opcional), foto de perfil (opcional), papel e permissões, empresa a que pertence e preferências de uso.</li>
      <li><strong>Dados de autenticação e segurança:</strong> senha (guardada apenas na forma de hash, nunca em texto), dados da verificação em duas etapas (segredo cifrado e códigos de recuperação em hash), tentativas de acesso, endereço IP e tipo de navegador das sessões, e a trilha de auditoria das ações realizadas.</li>
      <li><strong>Dados inseridos pelo Cliente:</strong> cadastros de pessoas e empresas (nome, CPF/CNPJ, contatos, endereços), produtos, estoques, pedidos, finanças, documentos e arquivos fiscais, certificados digitais (guardados cifrados) e credenciais de integrações (guardadas cifradas).</li>
      <li><strong>Dados técnicos:</strong> registros de funcionamento e de erros necessários para operar e proteger o serviço.</li>
      <li><strong>Comunicações:</strong> mensagens de suporte enviadas a nós e o histórico de avisos (e-mail e WhatsApp) que o Cliente configurar a partir da Plataforma.</li>
    </ul>,
  },
  {
    id: 'finalidades', title: 'Para que usamos e em que base legal',
    body: <ul>
      <li><strong>Prestar o serviço contratado</strong> (criar e manter contas, processar o que o Cliente registra, gerar relatórios e documentos) — execução de contrato.</li>
      <li><strong>Segurança e prevenção a fraudes</strong> (autenticação, bloqueio por tentativas, trilha de auditoria, backups) — legítimo interesse e obrigação de segurança.</li>
      <li><strong>Suporte e comunicação</strong> sobre o serviço (recuperação de senha, convites, avisos operacionais) — execução de contrato e legítimo interesse.</li>
      <li><strong>Cumprir obrigações legais ou regulatórias</strong> e exercer direitos em processos — obrigação legal e exercício regular de direitos.</li>
      <li><strong>Melhorar a Plataforma</strong>, com dados técnicos e, sempre que possível, agregados — legítimo interesse.</li>
    </ul>,
  },
  {
    id: 'compartilhamento', title: 'Com quem compartilhamos',
    body: <>
      <p>Não vendemos dados pessoais. Compartilhamos somente o necessário com:</p>
      <ul>
        <li><strong>Provedores de infraestrutura</strong> (hospedagem, banco de dados, armazenamento de cópias de segurança) que atuam como suboperadores sob obrigações de confidencialidade e segurança;</li>
        <li><strong>Serviços escolhidos pelo Cliente</strong> e acionados a partir da Plataforma: servidor de e-mail, Evolution API/WhatsApp, provedores de nota fiscal, SEFAZ e demais órgãos fiscais, marketplaces e bancos. Os dados seguem para eles por instrução do Cliente, e esses serviços têm suas próprias políticas;</li>
        <li><strong>Autoridades públicas</strong>, quando houver ordem legal ou obrigação regulatória;</li>
        <li><strong>Assessores</strong> (jurídicos, contábeis, de segurança), sob sigilo, quando necessário.</li>
      </ul>
    </>,
  },
  {
    id: 'internacional', title: 'Transferência internacional',
    body: <p>Alguns provedores de tecnologia podem armazenar ou processar dados fora do Brasil. Quando isso ocorrer, adotamos as salvaguardas previstas na LGPD (como cláusulas contratuais adequadas e provedores que ofereçam nível de proteção compatível).</p>,
  },
  {
    id: 'retencao', title: 'Por quanto tempo guardamos',
    body: <>
      <p>Mantemos os dados enquanto a conta do Cliente estiver ativa e pelo tempo necessário para cumprir obrigações legais e proteger direitos (por exemplo, registros de acesso e trilha de auditoria). Encerrado o contrato, os Dados do Cliente ficam disponíveis para exportação por um prazo razoável e depois são eliminados ou anonimizados, salvo guarda exigida por lei.</p>
      <p>Documentos fiscais e contábeis têm prazos legais de guarda que são de responsabilidade do Cliente; recomendamos manter cópia própria.</p>
    </>,
  },
  {
    id: 'seguranca', title: 'Como protegemos os dados',
    body: <ul>
      <li>Isolamento dos dados de cada empresa no banco de dados (uma empresa não consegue ler os dados de outra);</li>
      <li>Senhas guardadas somente em hash; bloqueio temporário após tentativas erradas; verificação em duas etapas opcional;</li>
      <li>Certificados digitais, credenciais de integrações e segredos de autenticação guardados cifrados; cópias de segurança cifradas;</li>
      <li>Comunicação protegida por HTTPS e sessões com validade limitada;</li>
      <li>Controle de acesso por permissões e trilha de auditoria das ações relevantes.</li>
    </ul>,
  },
  {
    id: 'direitos', title: 'Seus direitos como titular',
    body: <>
      <p>A LGPD garante ao titular, entre outros direitos, confirmar a existência de tratamento, acessar seus dados, corrigir dados incompletos ou desatualizados, pedir anonimização, bloqueio ou eliminação de dados desnecessários, solicitar a portabilidade, obter informações sobre compartilhamentos, revogar o consentimento (quando for a base legal) e se opor a tratamentos irregulares.</p>
      <p>Para exercer seus direitos, escreva para <a href={`mailto:${VGON.email}`}>{VGON.email}</a>. Se os seus dados foram inseridos por uma empresa que usa a Plataforma (por exemplo, você é cliente dela), nós encaminharemos o pedido a essa empresa, que é a controladora, ou indicaremos como procurá-la. Responderemos nos prazos legais.</p>
    </>,
  },
  {
    id: 'cookies', title: 'Cookies e armazenamento no navegador',
    body: <p>Usamos apenas o que é essencial ao funcionamento: cookies de sessão (protegidos e sem leitura por scripts) para mantê-lo conectado e armazenamento local do navegador para lembrar preferências como tema claro/escuro e o estado do menu. <strong>Não usamos cookies de publicidade nem de rastreamento de terceiros.</strong></p>,
  },
  {
    id: 'menores', title: 'Crianças e adolescentes',
    body: <p>A Plataforma é destinada a empresas e seus profissionais, não a menores de 18 anos. Se identificarmos uso indevido de dados de menores, tomaremos as providências cabíveis.</p>,
  },
  {
    id: 'incidentes', title: 'Incidentes de segurança',
    body: <p>Em caso de incidente que possa acarretar risco ou dano relevante aos titulares, comunicaremos o Cliente e, quando exigido, a Autoridade Nacional de Proteção de Dados (ANPD), nos prazos e termos da lei, com a descrição do ocorrido e das medidas adotadas.</p>,
  },
  {
    id: 'alteracoes', title: 'Alterações desta política',
    body: <p>Podemos atualizar esta política para refletir mudanças legais ou do serviço. A versão vigente fica sempre nesta página, com a data da última atualização, e mudanças relevantes serão comunicadas pela Plataforma ou por e-mail.</p>,
  },
  {
    id: 'contato', title: 'Contato e encarregado de dados',
    body: <p>Dúvidas, pedidos de titulares e contato com o encarregado pelo tratamento de dados pessoais: <a href={`mailto:${VGON.email}`}>{VGON.email}</a> — {VGON.name}, CNPJ {VGON.cnpj}.</p>,
  },
];

export default function PrivacidadePage() {
  return (
    <LegalPage
      title="Política de privacidade"
      intro={<p>Levamos a proteção dos dados a sério. Aqui está, em linguagem direta, quais dados tratamos no {BRAND.name}, para quê, com quem e quais são os seus direitos.</p>}
      sections={S}
      other={{ href: '/termos', label: 'Termos de uso' }}
    />
  );
}
