// Логика комнаты. Правил боя тут нет: сервер только пересылает сообщения между двумя игроками.
// Не зависит от Cloudflare — одна и та же логика работает в Worker и в локальном dev-server.js.
export const MAX_MSG = 16384;
export const ALLOWED = new Set(['hello', 'start', 'act', 'bye']);
export const CODE_RE = /^[A-Z0-9]{4,8}$/;

const tx = (sock, text) => { try { sock.send(text); } catch (e) { /* сокет уже закрыт */ } };
const cl = (sock, code, reason) => { try { sock.close(code, reason); } catch (e) { /* уже закрыт */ } };

export class Room {
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
