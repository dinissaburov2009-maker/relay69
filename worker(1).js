// Cloudflare Worker + Durable Object: одна комната = один объект Room, код комнаты = его имя.
// Используется WebSocket Hibernation API: пока в комнате тихо, объект «спит» и не тратит бесплатный лимит.
import { DurableObject } from 'cloudflare:workers';

// Логика комнаты. Правил боя тут нет: сервер только пересылает сообщения между двумя игроками.
// Не зависит от Cloudflare — одна и та же логика работает в Worker и в локальном dev-server.js.
const MAX_MSG = 16384;
const ALLOWED = new Set(['hello', 'start', 'act', 'bye']);
const CODE_RE = /^[A-Z0-9]{4,8}$/;

const tx = (sock, text) => { try { sock.send(text); } catch (e) { /* сокет уже закрыт */ } };
const cl = (sock, code, reason) => { try { sock.close(code, reason); } catch (e) { /* уже закрыт */ } };

class Core {
  // peers: [{ role: 'host' | 'guest', sock }]
  constructor(peers = []) { this.peers = peers; }

  // Можно ли войти в эту роль: null — можно, иначе код ошибки
  check(role) {
    const has = (r) => this.peers.some((p) => p.role === r);
    if (role !== 'host' && role !== 'guest') return 'bad_role';
    if (role === 'host' && has('host')) return 'busy';
    if (role === 'guest' && !has('host')) return 'no_room';
    if (role === 'guest' && has('guest')) return 'full';
    return null;
  }

  join(role, sock) {
    const err = this.check(role);
    if (err) {
      tx(sock, JSON.stringify({ t: 'err', code: err }));
      cl(sock, 4000, err);
      return false;
    }
    this.peers.push({ role, sock });
    tx(sock, JSON.stringify({ t: 'welcome', role }));
    if (role === 'guest') for (const p of this.peers) if (p.sock !== sock) tx(p.sock, '{"t":"peer"}');
    return true;
  }

  message(sock, text) {
    if (typeof text !== 'string' || text.length > MAX_MSG) return;
    if (text === 'ping') { tx(sock, 'pong'); return; }
    let m = null;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !ALLOWED.has(m.t)) return;
    if (!this.peers.some((p) => p.sock === sock)) return;
    for (const p of this.peers) if (p.sock !== sock) tx(p.sock, text);
  }

  leave(sock) {
    const me = this.peers.find((p) => p.sock === sock);
    if (!me) return;
    this.peers = this.peers.filter((p) => p !== me);
    for (const p of this.peers) tx(p.sock, '{"t":"gone"}');
    if (me.role === 'host') {
      for (const p of this.peers) cl(p.sock, 1000, 'host_left');
      this.peers = [];
    }
  }
}


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (!m) return new Response('petushinye-boi relay: ok', { status: 200 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('bad code', { status: 400 });
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // «ping» → «pong» отвечает сама платформа, не будя объект
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // Состояние комнаты собираем из живых сокетов (после сна объект ничего не помнит).
  // gone — сокет, который только что закрылся: он мог уже пропасть из списка, но его роль ещё нужна.
  core(gone) {
    const peers = [];
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.role) peers.push({ role: a.role, sock: ws });
    }
    if (gone && !peers.some((p) => p.sock === gone)) {
      try { const a = gone.deserializeAttachment(); if (a && a.role) peers.push({ role: a.role, sock: gone }); } catch (e) { /* нет данных */ }
    }
    return new Core(peers);
  }

  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const [client, server] = Object.values(new WebSocketPair());
    const core = this.core();
    const err = core.check(role);
    if (err) {
      // Ошибку (код занят, комнаты нет, уже двое) отдаём через сокет: браузер покажет понятное сообщение
      server.accept();
      server.send(JSON.stringify({ t: 'err', code: err }));
      server.close(4000, err);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    core.join(role, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    this.core().message(ws, typeof message === 'string' ? message : '');
  }

  async webSocketClose(ws) {
    this.core(ws).leave(ws);
    try { ws.close(1000, 'bye'); } catch (e) { /* уже закрыт */ }
  }

  async webSocketError(ws) {
    this.core(ws).leave(ws);
  }
}
