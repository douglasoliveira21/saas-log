import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, FileText, HelpCircle, KeyRound, Mail, Package, Store } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { VGON } from '@/lib/company';
import './support.css';

export const metadata: Metadata = {
  title: `Central de ajuda e suporte — ${BRAND.name}`,
  description: 'Entre em contato com o suporte do ERP e encontre orientações sobre acesso, integrações, pedidos e documentos fiscais.',
};

const subject = 'Solicitação de suporte do ERP';
const emailBody = [
  'Olá, equipe de suporte.',
  '',
  'Empresa e CNPJ:',
  'Nome do responsável:',
  'E-mail cadastrado no ERP:',
  'Tela ou módulo:',
  'Descrição do problema:',
  'Mensagem de erro, se houver:',
  'Data e horário da ocorrência:',
].join('\n');
const emailLink = `mailto:${VGON.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(emailBody)}`;

const topics = [
  { icon: KeyRound, title: 'Acesso à conta', text: 'Recuperação de senha, autenticação em duas etapas e permissões de acesso.', href: '#acesso' },
  { icon: Store, title: 'Marketplaces', text: 'Autorização de lojas, conexão com a Amazon e acompanhamento de integrações.', href: '#integracoes' },
  { icon: Package, title: 'Pedidos e produtos', text: 'Vínculos por SKU, importação de pedidos e revisão de pendências.', href: '#pedidos' },
  { icon: FileText, title: 'Documentos fiscais', text: 'Preparação, transmissão e identificação de mensagens de rejeição.', href: '#fiscal' },
];

export default function HelpPage() {
  return (
    <div className="support-page">
      <header className="support-header">
        <Link href="/ajuda" aria-label={`Central de ajuda do ${BRAND.name}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full" src="/brand/logo.png" alt={BRAND.name} />
        </Link>
        <Link href="/login" className="btn">Acessar o ERP <ArrowRight size={16} aria-hidden /></Link>
      </header>
      <main id="conteudo" className="support-main">
        <section className="support-hero" aria-labelledby="support-title">
          <div>
            <span className="support-eyebrow"><HelpCircle size={16} aria-hidden /> Atendimento ao usuário</span>
            <h1 id="support-title">Central de ajuda e suporte</h1>
            <p>Encontre orientações para usar o ERP ou entre em contato com a equipe da {VGON.short}.</p>
            <a className="btn primary" href={emailLink}><Mail size={18} aria-hidden />Enviar solicitação por e-mail</a>
            <p className="support-contact">Nosso contato <a href={`mailto:${VGON.email}`}>{VGON.email}</a></p>
          </div>
          <aside className="support-request" aria-labelledby="request-title">
            <h2 id="request-title">Para facilitar o atendimento</h2>
            <ul>
              <li>Informe o nome da empresa e o CNPJ.</li>
              <li>Descreva a tela e os passos que levaram ao problema.</li>
              <li>Inclua a mensagem de erro e o horário da ocorrência.</li>
              <li>Anexe uma captura da tela ao e-mail, se necessário.</li>
            </ul>
            <p>Remova senhas, tokens e dados bancários das capturas antes de enviar.</p>
          </aside>
        </section>

        <section aria-labelledby="topics-title">
          <h2 id="topics-title" className="support-section-title">Como podemos ajudar?</h2>
          <div className="support-topics">
            {topics.map(({ icon: Icon, title, text, href }) => (
              <a key={href} href={href} className="support-topic">
                <Icon size={22} aria-hidden />
                <h3>{title}</h3><p>{text}</p>
                <span>Ver orientação <ArrowRight size={15} aria-hidden /></span>
              </a>
            ))}
          </div>
        </section>

        <section className="support-faq" aria-labelledby="faq-title">
          <h2 id="faq-title">Orientações rápidas</h2>
          <details id="acesso">
            <summary>Como recuperar o acesso à minha conta?</summary>
            <p>Na tela de login, selecione <Link href="/esqueci-senha">Esqueci minha senha</Link> e informe seu e-mail cadastrado. Se a mensagem de recuperação não chegar, confira a pasta de spam e entre em contato com o suporte informando a empresa e o e-mail utilizado.</p>
            <p>Para solicitar uma permissão de acesso, procure o administrador da sua empresa no ERP.</p>
          </details>
          <details id="integracoes">
            <summary>Como conectar uma loja da Amazon ou outro marketplace?</summary>
            <p>Entre no ERP, acesse Integrações, escolha o canal e selecione o depósito de origem. Siga as instruções de autorização e acompanhe o estado da conexão ao retornar ao sistema.</p>
            <p>Se houver uma pendência, informe ao suporte o canal, o nome da conexão e a mensagem exibida. As permissões concedidas no marketplace determinam os dados disponíveis para a integração.</p>
          </details>
          <details id="pedidos">
            <summary>Um pedido importado ficou com pendência. O que conferir?</summary>
            <p>Confira o depósito da conexão, o saldo disponível e se os itens do pedido estão vinculados aos produtos do ERP. Para produtos com variações, confira o SKU específico de cada variação.</p>
            <p>Ao solicitar ajuda, informe o número do pedido, o canal de origem e a pendência apresentada.</p>
          </details>
          <details id="fiscal">
            <summary>O que informar quando a nota fiscal apresentar um erro?</summary>
            <p>Copie o código e a mensagem completa da rejeição, informe o número do pedido e indique se a operação ocorreu em homologação ou produção. Confira também as pendências exibidas na preparação da nota.</p>
            <p>As definições tributárias devem ser conferidas com o responsável fiscal ou contador da empresa.</p>
          </details>
        </section>

        <section className="support-bottom" aria-labelledby="contact-title">
          <div><h2 id="contact-title">Precisa falar com nossa equipe?</h2><p>O botão abre seu aplicativo de e-mail com os campos da solicitação para você preencher e enviar.</p></div>
          <a className="btn primary" href={emailLink}><Mail size={18} aria-hidden />Falar com o suporte</a>
        </section>
      </main>
      <footer className="support-footer">
        <div><strong>{VGON.name}</strong><span>CNPJ {VGON.cnpj}</span><a href={`mailto:${VGON.email}`}>{VGON.email}</a></div>
        <nav aria-label="Informações do sistema"><Link href="/termos">Termos de uso</Link><Link href="/privacidade">Privacidade</Link><Link href="/login">Acessar o ERP</Link></nav>
      </footer>
    </div>
  );
}
