'use client';

import { BatteryWarning, LocateFixed, LogOut, MapPinOff, Settings } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/session';
import { clearTrackerBuffer, tracker, useTracker } from '@/lib/tracking';

/**
 * Conta de motorista: o GPS do aparelho é obrigatório. Enquanto a localização não estiver liberada, nada do sistema abre.
 * Também liga o envio da posição (só vale quando há rota em andamento) e avisa se o sinal cair no meio do trabalho.
 */
export function GpsGate({ children }: { children: ReactNode }) {
  const t = useTracker();
  const { logout } = useSession();
  const [slow, setSlow] = useState(false);
  const [skipBattery, setSkipBattery] = useState(false);
  useEffect(() => { tracker.start(); return () => tracker.stop(); }, []);
  // se o aparelho nem chega a perguntar, mostra o botão para pedir de novo
  useEffect(() => { if (t.status !== 'asking') { setSlow(false); return; } const id = setTimeout(() => setSlow(true), 4000); return () => clearTimeout(id); }, [t.status]);

  const batteryBlocked = t.native && t.battery === 'restricted' && !skipBattery && (t.status === 'ok' || t.status === 'weak');
  if (batteryBlocked) {
    return (
      <div className="gps-gate card" role="alertdialog" aria-labelledby="bat-title">
        <span className="gps-icon" aria-hidden><BatteryWarning size={28} /></span>
        <h1 id="bat-title">Libere a bateria para o GPS não parar</h1>
        <p className="muted">O Android pausa aplicativos para economizar bateria. Para o rastreio da rota continuar com a tela bloqueada ou com outro aplicativo aberto, o DistribuiHub precisa ficar <strong>sem restrição de bateria</strong>.</p>
        <ol className="gps-steps">
          <li>Toque em <strong>Permitir sem restrição</strong> e confirme.</li>
          <li>Se a janela não aparecer, use <strong>Abrir lista de apps</strong>, procure “DistribuiHub” e escolha <strong>Sem restrições</strong> (ou “Não otimizar”).</li>
          <li>Em Xiaomi, Samsung, Motorola e Huawei, ative também <strong>Início automático</strong> nos ajustes do aplicativo.</li>
          <li>Volte aqui e toque em <strong>Já liberei</strong>.</li>
        </ol>
        <div className="gps-actions">
          <button className="btn primary" onClick={() => void tracker.requestBattery()}><BatteryWarning aria-hidden />Permitir sem restrição</button>
          <button className="btn" onClick={() => void tracker.openBatterySettings()}><Settings aria-hidden />Abrir lista de apps</button>
          <button className="btn" onClick={() => void tracker.checkBattery()}>Já liberei</button>
        </div>
        {t.batteryAsks >= 2 && <button className="btn ghost sm" onClick={() => setSkipBattery(true)}>Continuar mesmo assim (o GPS pode parar com a tela bloqueada)</button>}
        <div className="gps-foot"><button className="btn ghost sm" onClick={() => { clearTrackerBuffer(); void logout(); }}><LogOut aria-hidden />Sair da conta</button></div>
      </div>
    );
  }

  if (t.status === 'ok' || t.status === 'weak') {
    return (
      <>
        {t.native && t.battery === 'restricted' && (
          <div className="alert warn" role="status" style={{ marginBottom: 12 }}>
            <BatteryWarning aria-hidden />
            <div>
              <strong>Libere a bateria para o GPS continuar com a tela bloqueada.</strong> Sem isso o Android pode pausar o aplicativo e sua rota deixa de ser acompanhada. Toque em “Permitir” e confirme.
              <div style={{ marginTop: 8 }}><button className="btn sm primary" onClick={() => void tracker.requestBattery()}>Permitir sem restrição de bateria</button></div>
            </div>
          </div>
        )}
        {t.status === 'weak' && (
          <div className="alert warn" role="status" style={{ marginBottom: 12 }}>
            <MapPinOff aria-hidden /><div><strong>Sem sinal de GPS no momento.</strong> Confira se a localização do aparelho está ligada e, se possível, vá para um local aberto. As posições pendentes serão enviadas quando o sinal voltar.</div>
          </div>
        )}
        {children}
      </>
    );
  }

  const denied = t.status === 'denied';
  const unsupported = t.status === 'unsupported';
  return (
    <div className="gps-gate card" role="alertdialog" aria-labelledby="gps-title" aria-describedby="gps-desc">
      <span className="gps-icon" aria-hidden>{denied || unsupported ? <MapPinOff size={28} /> : <LocateFixed size={28} />}</span>
      <h1 id="gps-title">{denied ? 'A localização está bloqueada' : unsupported ? 'Este aparelho não tem localização' : 'Ative o GPS para continuar'}</h1>
      <p id="gps-desc" className="muted">
        {unsupported
          ? 'Para trabalhar como motorista é obrigatório usar um aparelho com GPS. Abra o sistema em um celular com localização.'
          : denied
            ? 'Para usar o sistema como motorista a localização do celular é obrigatória. Libere o acesso à localização nos ajustes e volte aqui.'
            : 'Como motorista, sua localização é usada para acompanhar a rota e a entrega em tempo real. Ela só é registrada enquanto uma rota sua estiver em andamento.'}
      </p>
      {denied && (
        <ol className="gps-steps">
          <li>{t.native ? 'Toque em “Abrir ajustes” abaixo.' : 'Toque no cadeado (ou nos três pontos) ao lado do endereço do site.'}</li>
          <li>Em <strong>Permissões → Localização</strong>, escolha <strong>{t.native ? 'Permitir o tempo todo' : 'Permitir'}</strong>.</li>
          <li>Volte e toque em “Tentar de novo”.</li>
        </ol>
      )}
      {!unsupported && (
        <div className="gps-actions">
          <button className="btn primary" onClick={() => tracker.retry()} disabled={t.status === 'asking' && !slow}>
            <LocateFixed aria-hidden />{t.status === 'asking' && !slow ? 'Aguardando o aparelho…' : denied ? 'Tentar de novo' : 'Ativar localização'}
          </button>
          {denied && t.native && <button className="btn" onClick={() => void tracker.openSettings()}><Settings aria-hidden />Abrir ajustes</button>}
        </div>
      )}
      <div className="gps-foot">
        <button className="btn ghost sm" onClick={() => { clearTrackerBuffer(); void logout(); }}><LogOut aria-hidden />Sair da conta</button>
        <Link href="/privacidade" className="muted" style={{ fontSize: '0.84rem' }}>Como a localização é usada</Link>
      </div>
    </div>
  );
}
