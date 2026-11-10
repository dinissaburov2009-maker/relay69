// Cloudflare Worker + Durable Objects.
//  /room/КОД  — комната боя (Room): до 3 игроков, сервер только пересылает сообщения.
//  /hub?auth=ID.ТОКЕН — общий Hub: кто в сети, пати до 3, подбор живого соперника. Вход только с аккаунтом (токен проверяется по D1 pb-accounts).
// WebSocket Hibernation API: пока тихо, объекты «спят» и не тратят бесплатный лимит; всё состояние Hub лежит во вложениях сокетов.
import { DurableObject } from 'cloudflare:workers';
import { RoomCore, HubCore } from './core.js';

const CODE_RE = /^[A-Z0-9]{4,8}$/;

async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// «ID.ТОКЕН» → { id, nick } или null. Та же проверка, что в pb-accounts (sessions.hash = sha256(токен)).
async function authUser(env, raw) {
  const m = /^([A-Z0-9]{8})\.([A-Z0-9]{32})$/.exec(String(raw || ''));
  if (!m || !env.DB) return null;
  const row = await env.DB.prepare('SELECT s.acc AS acc, a.nick AS nick FROM sessions s JOIN accounts a ON a.id = s.acc WHERE s.hash = ?').bind(await sha(m[2])).first();
  if (!row || row.acc !== m[1]) return null;
  const nick = String(row.nick || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || ('Player' + m[1].slice(0, 4));
  return { id: m[1], nick };
}
const wsErr = (code) => {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept(); server.send(JSON.stringify({ t: 'err', code })); server.close(4000, code);
  return new Response(null, { status: 101, webSocket: client });
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ws = request.headers.get('Upgrade') === 'websocket';
    if (url.pathname === '/hub') {
      if (!ws) return new Response('expected websocket', { status: 426 });
      let u = null;
      try { u = await authUser(env, url.searchParams.get('auth')); } catch (e) { return wsErr('server_error'); }
      if (!u) return wsErr('unauthorized');
      const h = new Headers(request.headers); h.set('x-pb-id', u.id); h.set('x-pb-nick', u.nick);
      return env.HUB.get(env.HUB.idFromName('main')).fetch(new Request(request, { headers: h }));
    }
    const m = /^\/room\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (!m) return new Response('petushinye-boi relay: ok', { status: 200 });
    const code = m[1].toUpperCase();
    if (!CODE_RE.test(code)) return new Response('bad code', { status: 400 });
    if (!ws) return new Response('expected websocket', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  // gone — сокет, который только что закрылся: из списка он мог уже пропасть, а роль ещё нужна
  core(gone) {
    const peers = [];
    for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.role) peers.push({ role: a.role, sock: w }); }
    if (gone && !peers.some((p) => p.sock === gone)) {
      try { const a = gone.deserializeAttachment(); if (a && a.role) peers.push({ role: a.role, sock: gone }); } catch (e) { /* нет данных */ }
    }
    return new RoomCore(peers);
  }
  async fetch(request) {
    const role = new URL(request.url).searchParams.get('role');
    const [client, server] = Object.values(new WebSocketPair());
    const core = this.core();
    const err = core.check(role);
    if (err) {
      server.accept(); server.send(JSON.stringify({ t: 'err', code: err })); server.close(4000, err);
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role });
    core.join(role, server);
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) { this.core().message(ws, typeof message === 'string' ? message : ''); }
  async webSocketClose(ws) { this.core(ws).leave(ws); try { ws.close(1000, 'bye'); } catch (e) { /* уже закрыт */ } }
  async webSocketError(ws) { this.core(ws).leave(ws); }
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  core(gone) {
    const peers = [];
    for (const w of this.ctx.getWebSockets()) { const a = w.deserializeAttachment(); if (a && a.id) peers.push({ sock: w, a }); }
    if (gone && !peers.some((p) => p.sock === gone)) {
      try { const a = gone.deserializeAttachment(); if (a && a.id) peers.push({ sock: gone, a }); } catch (e) { /* нет данных */ }
    }
    return new HubCore(peers);
  }
  async rearm(core) {
    if (core.hasQueue()) { if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000); }
  }
  async fetch(request) {
    const id = request.headers.get('x-pb-id') || '', nick = request.headers.get('x-pb-nick') || '';
    if (!id) return new Response('forbidden', { status: 403 });
    // тот же аккаунт открыл вторую вкладку/телефон — старое соединение закрываем
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (a && a.id === id) { try { w.send(JSON.stringify({ t: 'err', code: 'replaced' })); w.close(4001, 'replaced'); } catch (e) { /* уже закрыт */ } this.core(w).leave(w); }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, nick, mmr: 0, ver: '', st: 'menu', party: '', lead: 0, pj: 0, rd: 0, q: null, rl: [0, 0], inv: 0 });
    server.send(JSON.stringify({ t: 'welcome', id, nick, online: this.ctx.getWebSockets().length }));
    return new Response(null, { status: 101, webSocket: client });
  }
  async webSocketMessage(ws, message) {
    const core = this.core();
    core.message(ws, typeof message === 'string' ? message : '');
    await this.rearm(core);
  }
  async alarm() {
    const core = this.core();
    if (core.tick()) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  async webSocketClose(ws) { this.core(ws).leave(ws); try { ws.close(1000, 'bye'); } catch (e) { /* уже закрыт */ } }
  async webSocketError(ws) { this.core(ws).leave(ws); }
}
