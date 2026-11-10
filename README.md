# relay69

Сервер онлайна «Петушиных боёв» (Cloudflare Workers + Durable Objects).

- `/room/КОД` — комната боя до 3 игроков (роли host, guest, guest2). Сервер только пересылает hello/start/act/bye/sig/say.
- `/hub?auth=ID.ТОКЕН` — общий Hub: кто в сети, пати до 3, подбор живого соперника по MMR. Токен — тот же, что выдаёт pb-accounts; проверяется по общей базе D1.

## Деплой

1. `npm install`
2. `npx wrangler deploy` (создастся класс Hub, привязка к D1 pb-accounts уже в wrangler.toml)
3. Тесты логики: `npm test`

## Протокол Hub (JSON)

Клиент → сервер: `hello {mmr}`, `st {st}`, `who`, `party_create`, `party_join {code}`, `party_leave`, `party_ready {ready}`, `party_kick {id}`, `party_invite {to}` (ник или id), `party_start {mode: '2v2'|'raid'}`, `queue {mode:'1v1', mmr, ms}`, `unqueue`.

Сервер → клиент: `welcome`, `online {n}`, `who {n,list}`, `party {code,max,leader,members}`, `invite {code,from}`, `invited`, `go {mode,room,seat,role,members}`, `match {room,role,opp}`, `nomatch`, `queue {on}`, `kicked`, `err {code}`.

Коды ошибок: unauthorized, replaced, no_party, party_full, not_leader, not_ready, too_many, alone, busy, offline, in_party, bad_mode.
