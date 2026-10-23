import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Servidor de TESTE que imita a forma da Evolution API v2 (instâncias, QR code, estado e envio de texto). NÃO é a Evolution:
 * os caminhos e corpos seguem guias de terceiros e precisam ser conferidos em um servidor real.
 */
export class MockEvolution {
  server!: Server;
  base = '';
  readonly apikey = 'chave-global-de-teste';
  instances = new Map<string, { state: 'close' | 'connecting' | 'open' }>();
  sent: { instance: string; number: string; text: string }[] = [];
  calls: string[] = [];
  failSend: number | null = null;
  /** Reiniciar a instância volta ao ar (sessão salva) ou não (aparelho desconectado no celular). */
  restartRecovers = true;

  async start() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const url = new URL(req.url ?? '/', 'http://x');
        const parts = url.pathname.split('/').filter(Boolean);
        const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
        this.calls.push(`${req.method} ${url.pathname}`);
        if (req.headers.apikey !== this.apikey) return send(401, { status: 401, error: 'Unauthorized' });
        const name = decodeURIComponent(parts[2] ?? '');
        if (req.method === 'POST' && url.pathname === '/instance/create') {
          if (this.instances.has(body.instanceName)) return send(403, { status: 403, response: { message: [`This name "${body.instanceName}" is already in use.`] } });
          this.instances.set(body.instanceName, { state: 'connecting' });
          return send(201, { instance: { instanceName: body.instanceName }, qrcode: { base64: 'data:image/png;base64,QUJD' } });
        }
        if (req.method === 'GET' && parts[1] === 'connect') {
          const i = this.instances.get(name); if (!i) return send(404, { status: 404 });
          i.state = i.state === 'open' ? 'open' : 'connecting';
          return send(200, { base64: 'data:image/png;base64,UVJDT0RF', code: 'abc', count: 1 });
        }
        if (req.method === 'GET' && parts[1] === 'connectionState') {
          const i = this.instances.get(name); if (!i) return send(404, { status: 404 });
          return send(200, { instance: { instanceName: name, state: i.state } });
        }
        if (req.method === 'GET' && parts[1] === 'fetchInstances') {
          const n = url.searchParams.get('instanceName') ?? '';
          return send(200, this.instances.has(n) ? [{ name: n, ownerJid: '5511999990000@s.whatsapp.net', connectionStatus: this.instances.get(n)!.state }] : []);
        }
        if (req.method === 'PUT' && parts[1] === 'restart') {
          const i = this.instances.get(name); if (!i) return send(404, { status: 404 });
          if (this.restartRecovers) i.state = 'open';
          return send(200, { instance: { instanceName: name, state: i.state } });
        }
        if (req.method === 'DELETE' && parts[1] === 'logout') {
          const i = this.instances.get(name); if (!i) return send(404, { status: 404 });
          i.state = 'close'; return send(200, { status: 'SUCCESS' });
        }
        if (req.method === 'POST' && parts[1] === 'sendText') {
          const i = this.instances.get(name);
          if (!i) return send(404, { status: 404 });
          if (this.failSend) return send(this.failSend, { status: this.failSend, error: 'falha simulada' });
          if (i.state !== 'open') return send(400, { status: 400, error: 'Bad Request', response: { message: ['not connected'] } });
          this.sent.push({ instance: name, number: body.number, text: body.text });
          return send(201, { key: { id: 'MSG1' }, status: 'PENDING' });
        }
        send(404, { status: 404, error: 'rota desconhecida no simulador' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
}
