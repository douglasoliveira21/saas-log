import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/legal';
import { BRAND } from '@/lib/brand';
import { VGON } from '@/lib/company';

export const metadata: Metadata = { title: `Termos de uso — ${BRAND.name}` };

const S: LegalSection[] = [
  {
    id: 'aceite', title: 'Quem somos e aceite',
    body: <>
      <p>O {BRAND.name} (“Plataforma”) é um sistema de gestão empresarial (ERP) oferecido pela <strong>{VGON.name}</strong>, inscrita no CNPJ sob o nº {VGON.cnpj} (“{VGON.short}”), na modalidade de software como serviço, acessado pela internet.</p>
      <p>Ao entrar na Plataforma, criar uma conta ou usá-la de qualquer forma, o Usuário declara ter lido e aceitado estes Termos de uso e a nossa <a href="/privacidade">Política de privacidade</a>. Quem não concordar não deve usar a Plataforma.</p>
    </>,
  },
  {
    id: 'definicoes', title: 'Definições',
    body: <ul>
      <li><strong>Cliente:</strong> a empresa que contrata a Plataforma e é titular da conta (ambiente) onde os dados dela ficam.</li>
      <li><strong>Usuário:</strong> a pessoa que acessa a Plataforma em nome do Cliente (proprietário, administrador, vendedor, motorista, contador etc.), com as permissões que o Cliente definir.</li>
      <li><strong>Dados do Cliente:</strong> todas as informações inseridas ou geradas pelo Cliente na Plataforma (cadastros, pedidos, estoques, financeiro, documentos fiscais, certificados digitais, entre outras).</li>
    </ul>,
  },
  {
    id: 'servico', title: 'O serviço',
    body: <>
      <p>A Plataforma reúne módulos como cadastro de produtos e clientes, estoque, vendas e pedidos, compras, financeiro, emissão e gestão de documentos fiscais, logística e entregas, integrações com canais de venda, indicadores e relatórios. Os módulos disponíveis dependem do plano contratado e da fase de desenvolvimento de cada recurso.</p>
      <p>A Plataforma é uma ferramenta de apoio. <strong>Ela não substitui o contador, o advogado nem a análise do Cliente.</strong> Parâmetros tributários, regras fiscais, alíquotas, comissões, políticas comerciais e demais configurações são definidos e validados pelo Cliente; a {VGON.short} não os fornece como aconselhamento fiscal, contábil ou jurídico.</p>
      <p>Recursos que dependem de terceiros (por exemplo, SEFAZ, certificado digital, provedores de nota fiscal, marketplaces, WhatsApp e e-mail) podem exigir credenciamento, homologação e configuração por parte do Cliente e estão sujeitos à disponibilidade e às regras desses terceiros.</p>
    </>,
  },
  {
    id: 'conta', title: 'Contas e acesso',
    body: <ul>
      <li>As contas são criadas pela administração do Cliente ou por convite; o cadastro aberto ao público não é oferecido.</li>
      <li>O acesso é pessoal e intransferível. O Usuário deve guardar a senha em sigilo, usar senha forte e, sempre que possível, ativar a verificação em duas etapas.</li>
      <li>O Cliente é responsável por conceder, revisar e retirar permissões de seus Usuários (inclusive ao desligar um colaborador) e por tudo que for feito com as credenciais de sua equipe.</li>
      <li>Suspeita de uso indevido da conta deve ser comunicada imediatamente para <a href={`mailto:${VGON.email}`}>{VGON.email}</a>. Podemos bloquear acessos temporariamente para proteger a Plataforma e os dados.</li>
    </ul>,
  },
  {
    id: 'uso', title: 'Uso permitido e proibido',
    body: <>
      <p>A Plataforma deve ser usada apenas para fins lícitos e de acordo com estes Termos. É proibido:</p>
      <ul>
        <li>tentar acessar dados de outros clientes, burlar a segurança, testar vulnerabilidades sem autorização escrita ou sobrecarregar a infraestrutura;</li>
        <li>copiar, revender, sublicenciar, fazer engenharia reversa ou criar obra derivada da Plataforma, salvo nos limites da lei;</li>
        <li>inserir conteúdo ilícito, malicioso ou que viole direitos de terceiros, inclusive dados pessoais tratados sem base legal;</li>
        <li>usar os envios automáticos (e-mail e WhatsApp) para spam, assédio, cobrança abusiva ou qualquer prática vedada pela lei ou pelas regras dos provedores.</li>
      </ul>
    </>,
  },
  {
    id: 'planos', title: 'Planos, avaliação e pagamento',
    body: <>
      <p>As condições comerciais (plano, limites de uso, valor, forma e prazo de pagamento) constam da proposta, do contrato ou da tela do plano do Cliente. Pode haver período de avaliação gratuita; ao seu término, a conta pode ficar somente para consulta até a contratação de um plano.</p>
      <p>Atraso no pagamento pode levar à restrição ou suspensão do acesso, preservados os Dados do Cliente pelo prazo da cláusula de encerramento.</p>
    </>,
  },
  {
    id: 'dados', title: 'Dados do Cliente e privacidade',
    body: <>
      <p>Os Dados do Cliente pertencem ao Cliente. A {VGON.short} os trata para prestar o serviço contratado, conforme a <a href="/privacidade">Política de privacidade</a> e a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).</p>
      <p>O Cliente declara ter base legal para inserir na Plataforma dados pessoais de seus clientes, fornecedores, colaboradores e demais titulares, e é responsável pela correção, atualização e legalidade desses dados e dos envios de comunicação que configurar.</p>
    </>,
  },
  {
    id: 'fiscal', title: 'Responsabilidade fiscal e legal do Cliente',
    body: <>
      <p>O Cliente é o único responsável pelas informações que lança, pelas regras tributárias que cadastra e aprova, pelos documentos fiscais que emite e pelo cumprimento de suas obrigações (fiscais, trabalhistas, consumeristas, regulatórias). Recomenda-se validar toda configuração com o contador e emitir primeiro em ambiente de homologação.</p>
      <p>O Cliente deve manter guardados os documentos que a lei exige (por exemplo, XML de notas fiscais) pelo prazo legal, mantendo cópia própria.</p>
    </>,
  },
  {
    id: 'terceiros', title: 'Integrações e serviços de terceiros',
    body: <p>A Plataforma pode se conectar a serviços de terceiros escolhidos pelo Cliente (marketplaces, WhatsApp, servidores de e-mail, provedores de nota fiscal, bancos, SEFAZ). Esses serviços têm termos próprios, podem mudar ou ficar indisponíveis e não estão sob o controle da {VGON.short}. O uso de automações de WhatsApp em volume pode levar o provedor a restringir ou banir o número; o risco é do Cliente.</p>,
  },
  {
    id: 'pi', title: 'Propriedade intelectual',
    body: <p>A Plataforma, o código, o design, as marcas e a documentação são de propriedade da {VGON.short} ou de seus licenciantes. A contratação concede ao Cliente apenas uma licença limitada, não exclusiva, intransferível e revogável de uso durante a vigência, nos limites do plano. Nada nestes Termos transfere ao Cliente qualquer direito de propriedade intelectual sobre a Plataforma, nem à {VGON.short} sobre os Dados do Cliente.</p>,
  },
  {
    id: 'disponibilidade', title: 'Disponibilidade, manutenção e suporte',
    body: <>
      <p>Empregamos esforços razoáveis para manter a Plataforma disponível e segura, com cópias de segurança periódicas. Podem ocorrer interrupções por manutenção, atualização, falha de terceiros ou casos fortuitos; sempre que possível, avisaremos com antecedência as paradas programadas.</p>
      <p>O suporte é prestado pelo e-mail <a href={`mailto:${VGON.email}`}>{VGON.email}</a>. Prazos e níveis de atendimento específicos, quando houver, constam do contrato.</p>
    </>,
  },
  {
    id: 'responsabilidade', title: 'Limitação de responsabilidade',
    body: <>
      <p>Na máxima extensão permitida pela lei, a {VGON.short} não responde por lucros cessantes, perda de oportunidade ou danos indiretos, nem por prejuízos decorrentes de: informações incorretas inseridas pelo Cliente; configuração fiscal ou tributária equivocada; uso indevido de credenciais; indisponibilidade ou mudança de serviços de terceiros; ou descumprimento destes Termos pelo Cliente ou por seus Usuários.</p>
      <p>Quando houver responsabilidade da {VGON.short}, ela se limita aos danos diretos comprovados, nos termos da lei e do contrato. Nada aqui afasta direitos que a legislação (inclusive a de defesa do consumidor, quando aplicável) não permita limitar.</p>
    </>,
  },
  {
    id: 'encerramento', title: 'Vigência, cancelamento e devolução dos dados',
    body: <>
      <p>Estes Termos vigoram enquanto o Cliente usar a Plataforma. O Cliente pode solicitar o cancelamento a qualquer momento, observadas as condições do contrato. Podemos suspender ou encerrar o acesso em caso de violação destes Termos, de fraude ou de inadimplência não regularizada.</p>
      <p>Após o encerramento, o Cliente poderá solicitar a exportação de seus dados por um prazo razoável informado no contrato ou por e-mail; depois disso, os dados serão eliminados ou anonimizados, ressalvadas as hipóteses de guarda exigidas por lei ou necessárias ao exercício regular de direitos.</p>
    </>,
  },
  {
    id: 'alteracoes', title: 'Alterações destes Termos',
    body: <p>Podemos atualizar estes Termos para refletir mudanças legais, técnicas ou comerciais. A versão vigente fica sempre disponível nesta página, com a data da última atualização. Mudanças relevantes serão comunicadas pela Plataforma ou por e-mail; o uso continuado depois do aviso indica concordância.</p>,
  },
  {
    id: 'lei', title: 'Lei aplicável e foro',
    body: <p>Estes Termos são regidos pelas leis da República Federativa do Brasil. Eventuais conflitos serão resolvidos no foro da comarca da sede da {VGON.short}, salvo disposição legal em sentido contrário ou foro diferente eleito em contrato específico com o Cliente.</p>,
  },
  {
    id: 'contato', title: 'Contato',
    body: <p>Dúvidas, solicitações e comunicações sobre estes Termos: <a href={`mailto:${VGON.email}`}>{VGON.email}</a> — {VGON.name}, CNPJ {VGON.cnpj}.</p>,
  },
];

export default function TermosPage() {
  return (
    <LegalPage
      title="Termos de uso"
      intro={<p>Leia com atenção. Estes Termos regulam o uso do {BRAND.name} e explicam o que esperamos de você e o que você pode esperar de nós.</p>}
      sections={S}
      other={{ href: '/privacidade', label: 'Política de privacidade' }}
    />
  );
}
