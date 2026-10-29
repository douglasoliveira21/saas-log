'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { Avatar, squareJpegBase64 } from '@/components/avatar';
import { Alert, PageHeader, useUi } from '@/components/ui';
import { MaskedInput } from '@/components/fields';
import { api } from '@/lib/api';
import { formatPhone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PasswordInput } from '@/components/password-input';
import { BackgroundGpsCard } from '@/components/background-gps-card';

/** Meu perfil: foto, nome e telefone, troca de senha e atalho para o segundo fator. */
export default function PerfilPage() {
  const { me, can, reload } = useSession();
  const ui = useUi();
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [photoKey, setPhotoKey] = useState(0);
  const fail = (e: unknown) => { setError((e as Error).message); setOk(''); };
  const done = (m: string) => { setOk(m); setError(''); };

  async function pick(f: File | undefined) {
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) return fail(new Error('Escolha uma imagem PNG, JPG ou WebP.'));
    setBusy('photo'); setError('');
    try {
      const b64 = await squareJpegBase64(f);
      await api('/auth/avatar', 'PUT', { contentType: 'image/jpeg', contentBase64: b64 });
      await reload(); setPhotoKey((k) => k + 1); done('Foto atualizada.');
    } catch (e) { fail(e); }
    setBusy(''); if (file.current) file.current.value = '';
  }
  async function removePhoto() {
    if (!(await ui.confirm({ title: 'Remover a foto?', message: 'O sistema volta a mostrar as suas iniciais.', confirmLabel: 'Remover' }))) return;
    setBusy('photo');
    try { await api('/auth/avatar', 'DELETE'); await reload(); setPhotoKey((k) => k + 1); done('Foto removida.'); } catch (e) { fail(e); }
    setBusy('');
  }
  async function saveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy('profile');
    const f = new FormData(e.currentTarget);
    try { await api('/auth/profile', 'PATCH', { name: String(f.get('name')), phone: String(f.get('phone') ?? '') }); await reload(); done('Dados atualizados.'); } catch (err) { fail(err); }
    setBusy('');
  }
  async function setStyle(navStyle: 'CLASSIC' | 'LAUNCHER') {
    if (me.user.navStyle === navStyle) return;
    setBusy('style');
    try { await api('/auth/profile', 'PATCH', { navStyle }); await reload(); done(navStyle === 'LAUNCHER' ? 'Estilo alterado: início em blocos.' : 'Estilo alterado: menu lateral.'); } catch (e) { fail(e); }
    setBusy('');
  }
  async function savePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = new FormData(form);
    if (f.get('next') !== f.get('confirm')) return fail(new Error('As senhas novas não conferem.'));
    setBusy('password');
    try { await api('/auth/change-password', 'POST', { currentPassword: f.get('current'), newPassword: f.get('next') }); form.reset(); done('Senha alterada. As outras sessões abertas foram encerradas.'); } catch (err) { fail(err); }
    setBusy('');
  }

  return (
    <>
      <PageHeader title="Meu perfil" description={<>Seus dados de acesso. O e-mail é o seu login e não muda por aqui.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      <section className="card" style={{ marginBottom: 16 }} aria-label="Foto de perfil">
        <h2>Foto de perfil</h2>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <Avatar key={photoKey} name={me.user.name} self version={me.user.avatarVersion} size={88} />
          <div>
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label="Escolher foto" />
            <div className="row"><button className={`btn primary ${busy === 'photo' ? 'loading' : ''}`} disabled={busy === 'photo'} onClick={() => file.current?.click()}>{me.user.avatarVersion ? 'Trocar foto' : 'Enviar foto'}</button>
              {me.user.avatarVersion && <button className="btn" disabled={busy === 'photo'} onClick={removePhoto}>Remover</button>}</div>
            <p className="muted" style={{ fontSize: '0.82rem', margin: '8px 0 0' }}>PNG, JPG ou WebP. A imagem é recortada em quadrado e reduzida automaticamente. Colegas da sua empresa veem esta foto.</p>
          </div>
        </div>
      </section>

      {can('delivery.perform') && <BackgroundGpsCard />}

      <section className="card" style={{ marginBottom: 16 }} aria-label="Aparência">
        <h2>Estilo do sistema</h2>
        <p className="muted" style={{ marginTop: 0 }}>Escolha como prefere navegar. Vale só para a sua conta e acompanha você em qualquer aparelho.</p>
        <div className="grid cols-2" role="radiogroup" aria-label="Estilo do sistema">
          {([['CLASSIC', 'Menu lateral (clássico)', 'Menus que abrem e fecham na lateral, com o painel de indicadores como página inicial.'], ['LAUNCHER', 'Início em blocos', 'Tela inicial com um bloco colorido por módulo. Ao abrir um módulo o menu lateral some e fica só o botão “Voltar ao início”.']] as const).map(([v, t, d]) => {
            const on = (me.user.navStyle ?? 'CLASSIC') === v;
            return (
              <button key={v} type="button" role="radio" aria-checked={on} disabled={busy === 'style'} onClick={() => void setStyle(v)} className="card" style={{ textAlign: 'left', cursor: 'pointer', borderColor: on ? 'var(--brand)' : undefined, boxShadow: on ? '0 0 0 2px var(--brand)' : undefined, margin: 0 }}>
                <strong>{t}</strong> {on && <span className="badge ok">Em uso</span>}
                <div className="muted" style={{ fontSize: '0.84rem', marginTop: 4 }}>{d}</div>
              </button>
            );
          })}
        </div>
      </section>

      <form className="card" style={{ marginBottom: 16 }} onSubmit={saveProfile}>
        <h2>Dados pessoais</h2>
        <div className="form-grid">
          <div><label htmlFor="pf-name">Nome *</label><input id="pf-name" name="name" required minLength={2} maxLength={120} defaultValue={me.user.name} /></div>
          <div><label htmlFor="pf-email">E-mail (login)</label><input id="pf-email" value={me.user.email} readOnly aria-readonly="true" /></div>
          <div><label htmlFor="pf-phone">Telefone</label><MaskedInput id="pf-phone" name="phone" kind="phone" defaultValue={me.user.phone ? formatPhone(me.user.phone) : ''} /></div>
        </div>
        <div className="row" style={{ marginTop: 12 }}><button className={`btn primary ${busy === 'profile' ? 'loading' : ''}`} disabled={busy === 'profile'}>Salvar dados</button></div>
      </form>

      <form className="card" style={{ marginBottom: 16 }} onSubmit={savePassword}>
        <h2>Alterar senha</h2>
        <div className="form-grid">
          <div><label htmlFor="pw-cur">Senha atual *</label><PasswordInput id="pw-cur" name="current"  autoComplete="current-password" required /></div>
          <div><label htmlFor="pw-new">Nova senha *</label><PasswordInput id="pw-new" name="next"  autoComplete="new-password" required minLength={8} /></div>
          <div><label htmlFor="pw-cf">Repita a nova senha *</label><PasswordInput id="pw-cf" name="confirm"  autoComplete="new-password" required minLength={8} /></div>
        </div>
        <p className="muted" style={{ fontSize: '0.82rem' }}>Use letras e números, bem diferente da atual. Ao trocar, as outras sessões abertas (outros aparelhos) são encerradas; esta continua.</p>
        <div className="row"><button className={`btn primary ${busy === 'password' ? 'loading' : ''}`} disabled={busy === 'password'}>Alterar senha</button></div>
      </form>

      <section className="card">
        <h2>Verificação em duas etapas</h2>
        <p className="muted" style={{ marginTop: 0 }}>Proteja a conta com o código do aplicativo autenticador. {me.user.mfaEnabled ? <span className="badge ok">Ativa</span> : <span className="badge warn">Desligada</span>}</p>
        <Link href="/seguranca" className="btn">Configurar segundo fator</Link>
      </section>
    </>
  );
}
