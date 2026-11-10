// Cloudflare Worker + Durable Object: одна комната = один объект Room, код комнаты = его имя.
// Используется WebSocket Hibernation API: пока в комнате тихо, объект «спит» и не тратит бесплатный лимит.
import { DurableObject } from 'cloudflare:workers';
import { Room as Core, CODE_RE } from './relay-core.js';

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
