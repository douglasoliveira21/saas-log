/** Link fixo para o APK mais novo (GitHub Releases, publicado pelo workflow "Aplicativo Android (APK)"). */
export const APK_URL = process.env.NEXT_PUBLIC_APK_URL ?? 'https://github.com/douglasoliveira21/saas-log/releases/latest/download/distribuihub.apk';

/** Botão "Baixar app" do topo. Escondido dentro do próprio aplicativo (lá ele não faz sentido). */
export function ApkDownload() {
  return (
    <a className="apk-btn" href={APK_URL} download="distribuihub.apk" rel="noopener" title="Baixar o aplicativo para Android (APK)" aria-label="Baixar o aplicativo para Android">
      <svg className="apk-ico" viewBox="0 0 24 24" aria-hidden width="20" height="20">
        <path fill="currentColor" d="M6 9h12v7.5a1.5 1.5 0 0 1-1.5 1.5H15v2.5a1.25 1.25 0 0 1-2.5 0V18h-1v2.5a1.25 1.25 0 0 1-2.5 0V18H7.5A1.5 1.5 0 0 1 6 16.5zM3.75 9A1.25 1.25 0 0 1 5 10.25v5a1.25 1.25 0 0 1-2.5 0v-5A1.25 1.25 0 0 1 3.75 9m16.5 0a1.25 1.25 0 0 1 1.25 1.25v5a1.25 1.25 0 0 1-2.5 0v-5A1.25 1.25 0 0 1 20.25 9M15.3 3.1l1.05-1.6a.3.3 0 0 0-.5-.33L14.77 2.8A6.4 6.4 0 0 0 12 2.2a6.4 6.4 0 0 0-2.77.6L8.15 1.17a.3.3 0 0 0-.5.33l1.05 1.6A5.3 5.3 0 0 0 6 7.9V8h12v-.1a5.3 5.3 0 0 0-2.7-4.8M9.6 6.2a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4m4.8 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4" />
      </svg>
      <span className="apk-txt"><small>Baixar o app</small><strong>Android</strong></span>
    </a>
  );
}
