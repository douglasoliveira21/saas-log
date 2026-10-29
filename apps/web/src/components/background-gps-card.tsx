'use client';

import { BatteryCharging, BellRing, LocateFixed, MapPinOff, Settings } from 'lucide-react';
import { useEffect } from 'react';
import { tracker, useTracker } from '@/lib/tracking';

/**
 * Opção "GPS e localização em segundo plano" (no app). Chave liga/desliga + estado de cada requisito do Android:
 * localização, bateria e a notificação fixa que mantém o serviço vivo.
 */
export function BackgroundGpsCard() {
  const t = useTracker();
  useEffect(() => { void tracker.checkBattery(); }, []);
  if (!t.native) {
    return (
      <section className="card" style={{ marginBottom: 16 }} aria-label="GPS em segundo plano">
        <h2>GPS e localização em segundo plano</h2>
        <p className="muted" style={{ marginTop: 0 }}>Essa opção existe no <strong>aplicativo DistribuiHub</strong> (Android). No navegador o GPS só funciona com a página aberta e a tela ligada.</p>
      </section>
    );
  }
  const gps = t.status === 'ok' ? ['ok', 'Ativa'] : t.status === 'denied' ? ['danger', 'Bloqueada'] : t.status === 'weak' ? ['warn', 'Sem sinal agora'] : ['warn', 'Aguardando'];
  const bat = t.battery === 'ok' ? ['ok', 'Sem restrição'] : t.battery === 'restricted' ? ['danger', 'Restrita'] : ['warn', 'Verificando'];
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="GPS em segundo plano">
      <div className="card-head">
        <h2>GPS e localização em segundo plano</h2>
        <label className="switch" title="Manter o GPS funcionando em segundo plano">
          <input type="checkbox" role="switch" checked={t.background} onChange={(e) => tracker.setBackground(e.target.checked)} aria-label="Manter o GPS e a localização em segundo plano" />
          <span className="switch-track" aria-hidden />
        </label>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {t.background
          ? 'Ligado: o GPS continua funcionando com a tela bloqueada ou com outro aplicativo aberto. O Android mostra uma notificação fixa do DistribuiHub enquanto isso. A localização só é registrada com uma rota em andamento.'
          : 'Desligado: o GPS só funciona com o aplicativo aberto na tela. Com a tela bloqueada ou em outro app, o acompanhamento da rota pára.'}
      </p>
      <ul className="bg-list">
        <li><LocateFixed aria-hidden /><span>Localização</span><span className={`badge ${gps[0]}`}>{gps[1]}</span></li>
        <li><BatteryCharging aria-hidden /><span>Bateria do aplicativo</span><span className={`badge ${bat[0]}`}>{bat[1]}</span>{t.battery === 'restricted' && <button className="btn sm" onClick={() => void tracker.requestBattery()}>Liberar</button>}</li>
        <li><BellRing aria-hidden /><span>Notificação fixa</span><span className={`badge ${t.background ? 'ok' : ''}`}>{t.background ? 'Em uso' : 'Desligada'}</span></li>
      </ul>
      {t.status === 'denied' && <div className="alert error" role="alert" style={{ marginTop: 10 }}><MapPinOff aria-hidden /><div>A localização está bloqueada. <button className="btn sm" onClick={() => void tracker.openSettings()}><Settings aria-hidden />Abrir ajustes</button></div></div>}
      <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>Para funcionar de verdade em segundo plano, a permissão de localização precisa estar em <strong>“Permitir o tempo todo”</strong> e o app sem restrição de bateria.</p>
    </section>
  );
}
