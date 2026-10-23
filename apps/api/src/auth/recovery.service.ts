import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { getConfig } from '../config/app.config';
import { hashPassword, newOpaqueToken, sha256, validatePasswordPolicy } from '../common/password';
import { actionMail, Mailer } from '../notify/mailer';
import { PrismaService } from '../prisma/prisma.service';

const RESET_TTL_MS = 60 * 60_000;

/** Recuperação de senha por e-mail: a resposta é sempre a mesma (não revela se o e-mail existe) e o link vale 1 hora, uma única vez. */
@Injectable()
export class RecoveryService {
  private readonly log = new Logger(RecoveryService.name);
  constructor(private readonly prisma: PrismaService, private readonly mailer: Mailer) {}

  async forgot(emailIn: string) {
    const email = emailIn.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.status === 'ACTIVE') {
      // no máximo 3 pedidos por hora por usuário (contra uso do envio como spam)
      const recent = await this.prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
      if (recent < 3) {
        const token = newOpaqueToken();
        await this.prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) } });
        const app = getConfig().appName;
        const m = actionMail(app, `Olá, ${user.name}.`, ['Recebemos um pedido para redefinir a sua senha. O link vale por 1 hora e só pode ser usado uma vez.', 'Se não foi você, ignore este e-mail: a sua senha continua a mesma.'], { label: 'Criar nova senha', url: this.mailer.link(`/redefinir-senha?token=${token}`) });
        const r = await this.mailer.send({ to: user.email, subject: `${app}: redefinição de senha`, ...m });
        if (!r.ok) this.log.warn(`e-mail de redefinição não enviado userId=${user.id}: ${r.reason}`);
      }
    }
    return { ok: true, message: 'Se o e-mail estiver cadastrado, enviamos o link para criar uma nova senha.' };
  }

  async reset(token: string, password: string) {
    const policy = validatePasswordPolicy(password);
    if (policy) throw new BadRequestException(policy);
    const row = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw new BadRequestException('Link inválido ou expirado. Peça um novo.');
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction(async (tx) => {
      // "usar" o token é atômico: duas requisições simultâneas não passam as duas
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count !== 1) throw new BadRequestException('Link inválido ou expirado. Peça um novo.');
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
      await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.refreshSession.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }); // encerra todas as sessões
    });
    return { ok: true };
  }
}
