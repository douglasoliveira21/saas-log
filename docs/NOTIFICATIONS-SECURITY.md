# Avisos ao cliente, conta e segurança, comissão por meta

## O que existe (`apps/api/src/notify/`, `auth/`, `users/invites.ts`, `commissions/goal-bonus.ts`)

**Recuperação de senha**: `POST /api/auth/forgot-password` (resposta sempre igual, não revela se o e-mail existe; no máximo 3 pedidos/hora por usuário) e `POST /api/auth/reset-password`. O link vale 1 hora e uma vez; ao trocar a senha todas as sessões abertas são encerradas. Páginas `/esqueci-senha` e `/redefinir-senha`.

**Convite por e-mail** (Usuários e papéis → Convidar por e-mail): link de 7 dias e uso único; o convidado escolhe a senha (se o e-mail já tem conta, confirma a senha atual). Respeita o limite do plano e a regra "não atribuir papel maior que o seu". Se o e-mail falhar, o administrador recebe o link na tela para repassar. O token carrega o id da empresa e só o hash é guardado.

**Segundo fator (2FA)**: aplicativo autenticador (TOTP, RFC 6238) + 8 códigos de recuperação de uso único. Tela "Segurança da conta" (menu do usuário). Com 2FA ativo, o login com a senha devolve só um token de 5 minutos (chave própria, não serve de sessão); o código é conferido em `/api/auth/mfa/verify`. Erros contam para o bloqueio de 15 minutos, e o mesmo código não vale duas vezes. **Não** há 2FA obrigatório por empresa nem por papel (cada pessoa liga o seu).

**Avisos ao cliente** (menu Administração → Avisos ao cliente; permissão `notifications.manage`): vencimento (N dias antes), status do pedido (status escolhidos) e cobrança (após N dias de atraso, repetindo a cada N dias). Tudo começa **desligado**. Só vai para cliente com contato cadastrado que não pediu para sair (opt-out na ficha do cliente → Crédito); nada se repete (chave de deduplicação por canal); todo envio fica no histórico, com o motivo da falha. Pedidos de marketplace não geram aviso. Os textos podem ser trocados (variáveis `{cliente}`, `{pedido}`...). O envio automático roda a cada 5 minutos **entre 8h e 20h (Brasília)**; "Enviar agora" varre e envia na hora. Falha temporária tenta até 3 vezes.

**WhatsApp pela Evolution API**: cada empresa tem a instância `dh-<id da empresa>`; "Conectar WhatsApp" mostra o QR code e a tela confere sozinha quando o celular lê. Rotas usadas: `POST /instance/create`, `GET /instance/connect/{i}`, `GET /instance/connectionState/{i}`, `GET /instance/fetchInstances`, `DELETE /instance/logout/{i}`, `POST /message/sendText/{i}`, com o cabeçalho `apikey` (chave global).

**Comissão por meta**: faixas de bônus (a partir de X% da meta: % sobre o vendido no mês ou valor fixo; vale a maior faixa atingida). A meta é a de Gestão → Metas e o "vendido" é o mesmo da tela de metas (confirmado no mês, líquido de devoluções). O mês corrente é só projeção; o mês **encerrado** é apurado em Vendedores e comissões → Comissão por meta → Apurar mês. A apuração é congelada e entra no pagamento de comissões e no repasse ao Financeiro (título a pagar).

## Verificado e não verificado

- Tudo acima passou em testes automáticos de ponta a ponta (`account-security`, `notifications`, `goal-bonus`) contra o banco real, com **servidor de e-mail e Evolution API simulados**.
- **Nunca testado com SMTP real nem com uma Evolution API real.** Os caminhos e corpos da Evolution v2 vieram de guias de terceiros: confira na primeira conexão (a chave global é aceita em todas as rotas?). O envio de e-mail depende da reputação do domínio (SPF/DKIM/DMARC) para não cair em spam.
- WhatsApp: mensagens automáticas em volume podem levar o WhatsApp a restringir o número. Cobrança por WhatsApp/e-mail deve ser revisada com o jurídico/financeiro (LGPD e Código de Defesa do Consumidor). Há opt-out por cliente, mas **não** há leitura de resposta "SAIR".
- Bônus apurado não muda com devolução posterior (é a regra escolhida: previsível); ajuste manual deve ser feito no repasse.
- Sem tela para reenviar convite com novo e-mail diferente do original (cancele e convide de novo).
