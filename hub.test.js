import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubCore, RoomCore, PARTY_MAX } from './core.js';

// Фальшивый сокет: запоминает присланное и вложение
const mk = (id, nick, mmr = 1000) => {
  const sock = { got: [], closed: null, att: null, send(t) { this.got.push(JSON.parse(t)); }, close(c, r) { this.closed = [c, r]; }, serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); } };
  const a = { id, nick, mmr, st: 'menu', party: '', lead: 0, pj: 0, rd: 0, q: null, rl: [0, 0], inv: 0 };
  return { sock, a };
};
let clock = 100000;
const hub = (...ps) => new HubCore(ps, () => clock);
const last = (p, t) => [...p.sock.got].reverse().find((m) => m.t === t);
const say = (h, p, o) => h.message(p.sock, JSON.stringify(o));

test('пати: создать, пригласить, войти, готовность, старт рейда на троих', () => {
  const A = mk('AAAAAAAA', 'Alice'), B = mk('BBBBBBBB', 'Bob'), C = mk('CCCCCCCC', 'Carl'), D = mk('DDDDDDDD', 'Dan');
  const h = hub(A, B, C, D);
  say(h, A, { t: 'party_invite', to: 'bob' });
  const inv = last(B, 'invite'); assert.ok(inv); assert.equal(inv.from.nick, 'Alice');
  say(h, B, { t: 'party_join', code: inv.code });
  say(h, C, { t: 'party_join', code: inv.code.toLowerCase() });
  assert.equal(last(A, 'party').members.length, 3);
  say(h, D, { t: 'party_join', code: inv.code });
  assert.equal(last(D, 'err').code, 'party_full');
  say(h, A, { t: 'party_start', mode: 'raid' });
  assert.equal(last(A, 'err').code, 'not_ready');
  say(h, B, { t: 'party_ready', ready: true }); say(h, C, { t: 'party_ready', ready: true });
  say(h, A, { t: 'party_start', mode: '2v2' });
  assert.equal(last(A, 'err').code, 'too_many'); // 2v2 максимум двое
  say(h, A, { t: 'party_start', mode: 'raid' });
  const g = [A, B, C].map((p) => last(p, 'go'));
  assert.deepEqual(g.map((x) => x.role), ['host', 'guest', 'guest2']);
  assert.equal(new Set(g.map((x) => x.room)).size, 1);
  assert.equal(A.a.st, 'battle');
});

test('пати: чужой не стартует, лидер уходит — лидер переходит, выход сбрасывает готовность', () => {
  const A = mk('AAAAAAAA', 'Alice'), B = mk('BBBBBBBB', 'Bob');
  const h = hub(A, B);
  say(h, A, { t: 'party_create' }); const code = last(A, 'party').code;
  say(h, B, { t: 'party_join', code }); say(h, B, { t: 'party_ready', ready: true });
  say(h, B, { t: 'party_start', mode: '2v2' }); assert.equal(last(B, 'err').code, 'not_leader');
  say(h, A, { t: 'party_leave' });
  assert.equal(last(A, 'party').code, null);
  const s = last(B, 'party'); assert.equal(s.leader, 'BBBBBBBB'); assert.equal(s.members.length, 1);
  say(h, B, { t: 'party_start', mode: '2v2' }); assert.equal(last(B, 'err').code, 'alone');
});

test('приглашение: оффлайн и уже в пати', () => {
  const A = mk('AAAAAAAA', 'Alice'), B = mk('BBBBBBBB', 'Bob'), C = mk('CCCCCCCC', 'Carl');
  const h = hub(A, B, C);
  say(h, A, { t: 'party_invite', to: 'nobody' }); assert.equal(last(A, 'err').code, 'offline');
  say(h, B, { t: 'party_create' });
  clock += 2000; say(h, A, { t: 'party_invite', to: 'bob' }); assert.equal(last(A, 'err').code, 'in_party');
});

test('подбор: близкие по MMR находят друг друга, далёкий получает nomatch через q.ms', () => {
  clock = 5000;
  const A = mk('AAAAAAAA', 'Alice', 1000), B = mk('BBBBBBBB', 'Bob', 1060), F = mk('FFFFFFFF', 'Far', 3000);
  const h = hub(A, B, F);
  for (const p of [A, B, F]) say(h, p, { t: 'queue', mode: '1v1', mmr: p.a.mmr, ms: 5000 });
  assert.equal(h.tick(), true); // Far ещё ждёт
  const ma = last(A, 'match'), mb = last(B, 'match');
  assert.equal(ma.room, mb.room); assert.deepEqual([ma.role, mb.role], ['host', 'guest']); assert.equal(ma.opp.nick, 'Bob');
  assert.equal(F.a.q.m, 3000);
  clock += 5000;
  assert.equal(h.tick(), false);
  assert.ok(last(F, 'nomatch')); assert.equal(F.a.st, 'menu');
});

test('подбор: окно MMR растёт с ожиданием', () => {
  clock = 9000;
  const A = mk('AAAAAAAA', 'Alice', 1000), B = mk('BBBBBBBB', 'Bob', 1400);
  const h = hub(A, B);
  for (const p of [A, B]) say(h, p, { t: 'queue', mode: '1v1', mmr: p.a.mmr, ms: 20000 });
  h.tick(); assert.equal(last(A, 'match'), undefined);
  clock += 8000; h.tick(); assert.ok(last(A, 'match')); // 120 + 40*8 = 440 >= 400
});

test('очередь: в пати нельзя, отключение чистит очередь, спам режется', () => {
  const A = mk('AAAAAAAA', 'Alice'), B = mk('BBBBBBBB', 'Bob');
  const h = hub(A, B);
  say(h, A, { t: 'party_create' }); say(h, B, { t: 'party_join', code: last(A, 'party').code });
  say(h, A, { t: 'queue', mode: '1v1', mmr: 1000 }); assert.equal(last(A, 'err').code, 'in_party');
  say(h, B, { t: 'party_leave' });
  say(h, B, { t: 'queue', mode: '1v1', mmr: 1000 }); assert.ok(B.a.q);
  h.leave(B.sock); assert.equal(h.hasQueue(), false);
  const n = A.sock.got.length; clock += 6000;
  for (let i = 0; i < 40; i++) say(h, A, { t: 'who' });
  assert.equal(A.sock.got.length - n, 25);
});

test('комната: три игрока, роли, gone с ролью, уход хозяина закрывает всех', () => {
  const s = () => ({ got: [], closed: null, send(t) { this.got.push(t); }, close(c, r) { this.closed = [c, r]; } });
  const h = s(), g1 = s(), g2 = s(), core = new RoomCore();
  assert.equal(core.join('guest', g1), false); // комнаты ещё нет
  assert.ok(core.join('host', h)); assert.ok(core.join('guest', g1)); assert.ok(core.join('guest2', g2));
  assert.equal(core.join('guest2', s()), false);
  core.message(g1, JSON.stringify({ t: 'act', a: 1 }));
  assert.equal(h.got.at(-1), '{"t":"act","a":1}'); assert.equal(g2.got.at(-1), '{"t":"act","a":1}');
  core.message(g1, JSON.stringify({ t: 'evil' })); assert.equal(h.got.at(-1), '{"t":"act","a":1}');
  core.leave(g1); assert.match(h.got.at(-1), /"gone".*"guest"/);
  core.leave(h); assert.deepEqual(g2.closed, [1000, 'host_left']);
});
