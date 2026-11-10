// Чистая логика без Cloudflare: Room (комната боя до 3 игроков) и Hub (присутствие, пати, подбор).
// Сокет — любой объект с send/close (и serializeAttachment для Hub), поэтому логика тестируется в Node.
const tx = (sock, text) => { try { sock.send(text); } catch (e) { /* сокет уже закрыт */ } };
const cl = (sock, code, reason) => { try { sock.close(code, reason); } catch (e) { /* уже закрыт */ } };
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const rnd = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ''; for (let i = 0; i < n; i++) s += ALPHA[b[i] & 31]; return s; };

/* ---------- Комната боя: host + guest + guest2, сервер только пересылает ---------- */
export const MAX_MSG = 16384;
const ALLOWED = new Set(['hello', 'start', 'act', 'bye', 'sig', 'say']);
const ROLES = ['host', 'guest', 'guest2'];

export class RoomCore {
  constructor(peers = []) { this.peers = peers; } // [{ role, sock }]
  check(role) {
    const has = (r) => this.peers.some((p) => p.role === r);
    if (!ROLES.includes(role)) return 'bad_role';
    if (role === 'host') return has('host') ? 'busy' : null;
    if (!has('host')) return 'no_room';
    return has(role) ? 'full' : null;
  }
  join(role, sock) {
    const err = this.check(role);
    if (err) { tx(sock, JSON.stringify({ t: 'err', code: err })); cl(sock, 4000, err); return false; }
    this.peers.push({ role, sock });
    tx(sock, JSON.stringify({ t: 'welcome', role }));
    if (role !== 'host') for (const p of this.peers) if (p.sock !== sock) tx(p.sock, JSON.stringify({ t: 'peer', role }));
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
    for (const p of this.peers) tx(p.sock, JSON.stringify({ t: 'gone', role: me.role }));
    if (me.role === 'host') { for (const p of this.peers) cl(p.sock, 1000, 'host_left'); this.peers = []; }
  }
}

/* ---------- Hub: кто в сети, пати до 3, подбор живого соперника ---------- */
export const PARTY_MAX = 3;
export const MODES = { '2v2': { max: 2 }, raid: { max: 3 } };
const STATES = new Set(['menu', 'battle', 'search', 'raid', 'tower', 'event']);
const MAX_HUB_MSG = 2048;
const Q_MIN = 2000, Q_MAX = 20000, Q_DEF = 8000;
const clampN = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(b, Math.max(a, Math.round(v))) : d; };

// peers: [{ sock, a }], a — вложение сокета (переживает сон объекта):
// { id, nick, mmr, st, party, lead, pj, rd, q: {mode, m, since, ms} | null, rl: [start, count], inv }
export class HubCore {
  constructor(peers = [], now = Date.now) { this.peers = peers; this.now = now; }
  send(p, o) { tx(p.sock, JSON.stringify(o)); }
  err(p, code) { this.send(p, { t: 'err', code }); }
  save(p) { try { p.sock.serializeAttachment(p.a); } catch (e) { /* нет вложения */ } }
  find(sock) { return this.peers.find((p) => p.sock === sock); }
  hasQueue() { return this.peers.some((p) => p.a.q); }
  members(code) { return code ? this.peers.filter((p) => p.a.party === code).sort((x, y) => x.a.pj - y.a.pj) : []; }

  pushParty(code) {
    const ms = this.members(code);
    if (!ms.length) return;
    if (!ms.some((x) => x.a.lead)) { ms[0].a.lead = 1; this.save(ms[0]); }
    const lead = ms.find((x) => x.a.lead);
    const state = { t: 'party', code, max: PARTY_MAX, leader: lead.a.id, members: ms.map((x) => ({ id: x.a.id, nick: x.a.nick, mmr: x.a.mmr, ready: !!x.a.rd || x === lead, st: x.a.st })) };
    for (const x of ms) this.send(x, state);
  }
  unready(code) { for (const x of this.members(code)) if (x.a.rd) { x.a.rd = 0; this.save(x); } }
  leaveParty(p) {
    const code = p.a.party;
    if (!code) return;
    p.a.party = ''; p.a.lead = 0; p.a.rd = 0; this.save(p);
    this.send(p, { t: 'party', code: null });
    const rest = this.members(code);
    if (rest.length) { this.unready(code); this.pushParty(code); }
  }
  joinParty(p, code, lead) {
    if (p.a.party && p.a.party !== code) this.leaveParty(p);
    p.a.party = code; p.a.lead = lead ? 1 : 0; p.a.rd = 0; p.a.pj = this.now(); p.a.q = null; this.save(p);
    this.unready(code); this.pushParty(code);
  }

  message(sock, text) {
    const p = this.find(sock);
    if (!p || typeof text !== 'string' || text.length > MAX_HUB_MSG) return;
    let m = null;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const now = this.now();
    if (!p.a.rl || now - p.a.rl[0] > 5000) p.a.rl = [now, 0];
    if (++p.a.rl[1] > 25) return; // не больше 25 сообщений за 5 секунд
    switch (m.t) {
      case 'hello': p.a.mmr = clampN(m.mmr, 0, 100000, p.a.mmr); this.save(p); this.send(p, { t: 'online', n: this.peers.length }); if (p.a.party) this.pushParty(p.a.party); break;
      case 'st': if (STATES.has(m.st)) { p.a.st = m.st; if (m.st !== 'search') p.a.q = null; this.save(p); if (p.a.party) this.pushParty(p.a.party); } break;
      case 'who': {
        const list = this.peers.filter((x) => x !== p).sort((x, y) => Math.abs(x.a.mmr - p.a.mmr) - Math.abs(y.a.mmr - p.a.mmr)).slice(0, 30)
          .map((x) => ({ id: x.a.id, nick: x.a.nick, mmr: x.a.mmr, st: x.a.st }));
        this.send(p, { t: 'who', n: this.peers.length, list }); break;
      }
      case 'party_create': this.joinParty(p, rnd(5), true); break;
      case 'party_join': {
        const code = String(m.code || '').toUpperCase();
        const ms = this.members(code);
        if (!ms.length) return this.err(p, 'no_party');
        if (p.a.party === code) return this.pushParty(code);
        if (ms.length >= PARTY_MAX) return this.err(p, 'party_full');
        this.joinParty(p, code, false); break;
      }
      case 'party_leave': this.leaveParty(p); break;
      case 'party_ready': if (p.a.party && !p.a.lead) { p.a.rd = m.ready ? 1 : 0; this.save(p); this.pushParty(p.a.party); } break;
      case 'party_kick': {
        if (!p.a.lead) return this.err(p, 'not_leader');
        const t = this.members(p.a.party).find((x) => x.a.id === String(m.id || '').toUpperCase());
        if (t && t !== p) { this.leaveParty(t); this.send(t, { t: 'kicked' }); }
        break;
      }
      case 'party_invite': {
        if (now - (p.a.inv || 0) < 1500) return;
        p.a.inv = now; this.save(p);
        const q = String(m.to || '').trim().toLowerCase();
        const t = this.peers.find((x) => x !== p && (x.a.id.toLowerCase() === q || x.a.nick.toLowerCase() === q));
        if (!t) return this.err(p, 'offline');
        if (t.a.party) return this.err(p, 'in_party');
        if (!p.a.party) this.joinParty(p, rnd(5), true);
        else if (this.members(p.a.party).length >= PARTY_MAX) return this.err(p, 'party_full');
        this.send(t, { t: 'invite', code: p.a.party, from: { id: p.a.id, nick: p.a.nick } });
        this.send(p, { t: 'invited', to: { id: t.a.id, nick: t.a.nick } });
        break;
      }
      case 'party_start': {
        if (!p.a.party || !p.a.lead) return this.err(p, 'not_leader');
        const mode = MODES[m.mode] ? m.mode : '';
        if (!mode) return this.err(p, 'bad_mode');
        const ms = this.members(p.a.party);
        if (ms.length < 2) return this.err(p, 'alone');
        if (ms.length > MODES[mode].max) return this.err(p, 'too_many');
        if (ms.some((x) => !x.a.lead && !x.a.rd)) return this.err(p, 'not_ready');
        if (ms.some((x) => x.a.st === 'battle')) return this.err(p, 'busy');
        const room = rnd(8), roles = ['host', 'guest', 'guest2'];
        const list = ms.map((x, i) => ({ id: x.a.id, nick: x.a.nick, mmr: x.a.mmr, seat: i, role: roles[i] }));
        ms.forEach((x, i) => { x.a.st = 'battle'; x.a.rd = 0; x.a.q = null; this.save(x); this.send(x, { t: 'go', mode, room, seat: i, role: roles[i], members: list }); });
        this.pushParty(p.a.party);
        break;
      }
      case 'queue': {
        if (p.a.party && this.members(p.a.party).length > 1) return this.err(p, 'in_party');
        if (m.mode !== '1v1') return this.err(p, 'bad_mode');
        p.a.mmr = clampN(m.mmr, 0, 100000, p.a.mmr);
        p.a.q = { mode: '1v1', m: p.a.mmr, since: now, ms: clampN(m.ms, Q_MIN, Q_MAX, Q_DEF) };
        p.a.st = 'search'; this.save(p);
        this.send(p, { t: 'queue', on: true, ms: p.a.q.ms }); break;
      }
      case 'unqueue': if (p.a.q) { p.a.q = null; p.a.st = 'menu'; this.save(p); this.send(p, { t: 'queue', on: false }); } break;
      default: break;
    }
  }

  // Подбор: окно MMR растёт с ожиданием; кто не нашёл соперника за q.ms — получает nomatch (клиент берёт бота)
  tick() {
    const now = this.now(), win = (q) => Math.min(600, 120 + 40 * Math.floor((now - q.since) / 1000));
    const qs = this.peers.filter((p) => p.a.q).sort((x, y) => x.a.q.since - y.a.q.since), used = new Set();
    for (const A of qs) {
      if (used.has(A)) continue;
      let best = null, bd = Infinity;
      for (const B of qs) {
        if (B === A || used.has(B) || B.a.q.mode !== A.a.q.mode) continue;
        const d = Math.abs(A.a.q.m - B.a.q.m);
        if (d <= Math.max(win(A.a.q), win(B.a.q)) && d < bd) { best = B; bd = d; }
      }
      if (!best) continue;
      used.add(A); used.add(best);
      const room = rnd(8), pair = [[A, 'host', best], [best, 'guest', A]];
      for (const [x, role, o] of pair) {
        x.a.q = null; x.a.st = 'battle'; this.save(x);
        this.send(x, { t: 'match', room, role, opp: { id: o.a.id, nick: o.a.nick, mmr: o.a.mmr } });
      }
    }
    for (const p of qs) {
      if (!used.has(p) && p.a.q && now - p.a.q.since >= p.a.q.ms) { p.a.q = null; p.a.st = 'menu'; this.save(p); this.send(p, { t: 'nomatch' }); }
    }
    return this.hasQueue();
  }

  leave(sock) {
    const p = this.find(sock);
    if (!p) return;
    p.a.q = null; this.leaveParty(p);
    this.peers = this.peers.filter((x) => x !== p);
  }
}
