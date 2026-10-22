# Xonta Gate

**A trust layer in front of any MCP server.** One command puts Xonta Gate between your AI client (Claude Desktop, Cursor, your own agent) and an MCP server. The agent keeps working as before, but now:

- tools with hidden instructions in their descriptions (tool poisoning) are hidden and refused;
- if the server quietly changes tool descriptions in the middle of a session, actions get frozen;
- tools that change things (delete, send, pay, refund, push...) are counted, and over the budget the call is refused with "needs a human";
- every tool is rate limited, and no more than 4 calls of one tool run at the same time;
- hidden commands inside tool outputs ("SYSTEM: ignore your rules...") are flagged, and after a few of them actions get frozen;
- every call goes into a signed, hash-chained audit log. Change or delete one line and `xonta-gate verify` will show where.

The gate never rewrites what a tool returns and never runs anything by itself. It allows, refuses and records.

**Gate is the front door, not the whole house.** Behind it there is the Xonta orchestrator, which runs at [passport.xonta.ru](https://passport.xonta.ru) with open registration. There your agent gets a signed passport, takes an exam on tasks with known right answers and gets a mandate, a signed W3C credential that says how many actions it may take without a human. If the agent's actions go through the orchestrator gateway, it keeps a reputation from live traffic. In our sandbox runs the orchestrator goes further. When an agent starts making mistakes or gets swapped, its limit shrinks on its own, the agents it spawns are watched too, and agents choose between several orchestrators by their track record and move away from ones whose advice doesn't hold up. Gate today uses its own budget and doesn't read the mandate yet. How to connect is in [CONNECT.md](CONNECT.md), the sandbox runs are in [README.en.md](README.en.md).

Русская версия ниже.

## Try it in a minute

Check what an MCP server exposes and what the gate would block, nothing is served:

```bash
npx -y github:mrsergeiluzhnov/xonta check -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

```
14 tools
  read    read_text_file
  action  write_file
  action  move_file
  ...
budget: 20 actions per 3600s
```

## Claude Desktop, Cursor and other stdio clients

Put the gate in front of the server in your client config. Before:

```json
{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"] } } }
```

After:

```json
{ "mcpServers": { "files": { "command": "npx", "args": ["-y", "github:mrsergeiluzhnov/xonta", "--budget", "10", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"] } } }
```

Restart the client. The gate logs to stderr, so your client's MCP log shows what was blocked.

## Remote servers

```bash
npx -y github:mrsergeiluzhnov/xonta --url https://example.com/mcp --http 4950
# your agent now connects to http://127.0.0.1:4950/mcp, status at http://127.0.0.1:4950/gate/status
```

## Policy

Defaults work without any config. To tune, pass `--policy policy.json`:

```json
{
  "period_seconds": 3600,
  "actions_per_period": 20,
  "rate_per_minute": 60,
  "max_concurrent": 4,
  "block_high_risk": true,
  "freeze_on_change": true,
  "injections_to_freeze": 3,
  "tools": {
    "delete_file": { "max_per_period": 2 },
    "search": { "action": false },
    "run_shell": { "allow": false }
  }
}
```

Which tools count as actions is decided by the tool name (create, delete, write, send, pay, refund, push, merge...). Override any tool with `"action": true` or `false`.

`max_concurrent` caps how many calls of one tool run at once (per tool too). An agent once launched 10 to 11 parallel copies of a metered lookup on one key, and 31% of its requests came back as rate-limit refusals. Parallel copies on one key don't finish faster.

## Privacy. Who asks, what data, where it goes

Added in 0.18 after a story where an agent posted a monthly financial report to a public Slack channel. Turn it on with a `privacy` section in the policy. Gate then looks at every outgoing message itself and doesn't trust how the agent labels it.

```json
{
  "privacy": {
    "users":      { "ivan": { "clearance": 3 }, "intern": { "clearance": 1 } },
    "agents":     { "did:web:assistant.example": { "clearance": 3 } },
    "recipients": { "#general": { "audience": "D", "clearance": 1 }, "@ivan": { "audience": "A", "clearance": 3, "spaces_of": ["ivan"] } },
    "sources":    { "bank_statement": "finance" },
    "tools":      { "slack_post_message": { "recipient_arg": "channel", "content_args": ["text"] } },
    "categories": { "finance": { "actions_per_period": 3 } },
    "canaries":   ["Z-CANARY-7731"],
    "delay_irreversible_seconds": 30
  }
}
```

How it decides

- Five levels (public, work, personal, restricted, secret) and eight categories (general, work, customer data, finance, HR and legal, health, children, secrets). Each category has its own rules, how wide the audience may be and how many sends per hour. The owner can only make them stricter.
- The level comes from the data. Gate finds card numbers, IBANs, account and passport numbers, keys, sums next to money words, health and HR terms, and it decodes base64 and joins split digits first. The agent's label can only raise the level, never lower it. A label lower than the data is counted, and a few of those freeze privacy until a human looks.
- After an agent reads a sensitive source (a bank statement), everything it sends in the same task is treated at that level for 30 minutes. A retelling without numbers doesn't slip through.
- Every call carries the chain of who asked, `_xonta: { chain, category, task }`. It can be a person or another agent. The clearance is the lowest in the chain, and an unknown member counts as 0. So an outsider writing in by email or an unexamined agent in the middle can't pull out what the person at the start could see.
- Canaries are fake records you put into your sources. If one shows up in an outgoing message, that's proof, the send is denied and privacy freezes. Several refusals in a row also freeze it, it looks like the agent is probing for a way around.
- Irreversible sends (a post, an email, a payment) can be held for N seconds. The owner sees `xonta-gate cancel ID` in the log and can stop it.

What leaks from this layer is kept small on purpose. The agent gets one sentence ("this needs a human") with no reason, so it can't learn where the line is. The reason goes to the owner and into the log, the log has keyed hashes, not content. `xonta-gate send-privacy` sends only counts to the orchestrator, people as hashes. The orchestrator turns them into a verdict on how honestly the agent labels data, and if it understates, the next mandate sends sensitive data through a human.

Ten scenarios with results are in [results/privacy-demo](results/privacy-demo/REPORT.en.md), `node stand/privacy-demo.js`.

## Tested on the official MCP servers

We ran `check` on 14 official servers from the `@modelcontextprotocol` npm scope. Each one was started locally and only asked for its tool list. No tool was called, nothing went to outside services, tokens were dummies just so the servers would start. 11 servers started, 3 didn't (puppeteer needs a browser, redis needs a database, gitlab sends a tool schema the MCP SDK rejects). Script: `npm run gate:survey`.

| Server | Tools | Counted as actions | Blocked |
|---|---|---|---|
| filesystem | 14 | 4 (write, edit, create dir, move) | 0 |
| memory | 9 | 6 | 0 |
| everything | 13 | 2 (two toggles) | 0 |
| sequential-thinking | 1 | 0 | 0 |
| github | 26 | 12 | 0 |
| slack | 8 | 3 | 0 |
| brave-search | 2 | 0 | 0 |
| google-maps | 7 | 0 | 0 |
| postgres | 1 | 0 (the server is read only) | 0 |
| everart | 1 | 0 | 0 |
| aws-kb-retrieval | 1 | 0 | 0 |
| **total** | **83** | **27** | **0** |

What we found and fixed in 0.14.5:

- no harmless tool was blocked, 0 of 83;
- 5 tools that change things were counted as reads: `add_observations` (memory), `fork_repository` and `add_issue_comment` (github), `slack_reply_to_thread` and `slack_add_reaction`. The action words now include add, fork, reply, comment, react, toggle and a few more (submit, close, archive, assign, grant, revoke, enable, disable, install, restart, stop, schedule, book). Words inside other words don't count, so `get_address` and `get_pull_request_comments` stay reads;
- one false warning: `read_file` in filesystem says "DEPRECATED: Use read_text_file instead" and was flagged as shadowing another tool. A deprecation note pointing to a sibling tool is no longer flagged, unless it also says always or never.

Still a judgement call: `generate_image` (everart) spends credits but isn't counted. If that matters to you, set `"generate_image": { "action": true }` in the policy.

## What it costs

Measured on the test server from `test/fixtures`, 1000 calls after 50 warm-up, 3 runs, Node 22, 2 CPUs. Script: `npm run gate:bench`.

| | median | p95 |
|---|---|---|
| direct call | 0.23-0.34 ms | 0.5-0.7 ms |
| through the gate | 1.1-1.3 ms | 2.8-2.9 ms |
| **added by the gate** | **0.9-1.0 ms** | **2.1-2.3 ms** |

About one millisecond per call, most of it the second process hop and the signed log write. A model answer takes seconds, so you won't notice it. The audit log takes about 540 KB per 1000 calls (around 550 bytes per entry, hashes only, no content).

## Audit log

Everything is in `~/.xonta-gate` (or `--dir`): `audit.jsonl`, the signing key and its public part.

```bash
npx -y github:mrsergeiluzhnov/xonta verify   # chain intact, signatures valid, or the exact entry that was tampered with
npx -y github:mrsergeiluzhnov/xonta report   # calls, refusals by reason, hidden commands seen, description changes
```

The log stores hashes of arguments and outputs, not the content itself, so it can be shared with a security team.

## What it does not do

It does not make an unsafe server safe. The checks on descriptions and outputs are heuristics, "nothing found" is not a guarantee. It can't stop a server that does harm without being called. And if your keys are in a public repo, no gate will help, clean that up first.

Gate is the simple part of Xonta. The full orchestrator learns how much an agent can be trusted from exams and live work and catches agents that drift, see [README.en.md](README.en.md).

---

# Xonta Gate по-русски

**Слой доверия перед любым MCP-сервером.** Одна команда ставит Xonta Gate между вашим ИИ-клиентом (Claude Desktop, Cursor, свой агент) и MCP-сервером. Агент работает как раньше, но теперь:

- инструменты со скрытыми инструкциями в описаниях (tool poisoning) спрятаны и не вызываются;
- если сервер посреди работы тихо меняет описания инструментов, действия замораживаются;
- инструменты, которые что-то меняют (удалить, отправить, оплатить, вернуть деньги, запушить), считаются, и сверх бюджета вызов отклоняется с пометкой «нужен человек»;
- у каждого инструмента есть предел частоты, и одновременно идут не больше 4 вызовов одного инструмента;
- скрытые команды в ответах инструментов («SYSTEM: игнорируй правила…») отмечаются, после нескольких таких действия замораживаются;
- каждый вызов попадает в подписанный журнал с цепочкой хэшей. Поменяли или удалили строку — `xonta-gate verify` покажет, где.

Шлюз не переписывает ответы инструментов и сам ничего не запускает. Он пропускает, отказывает и записывает.

**Шлюз это входная дверь, а не весь дом.** За ним стоит оркестратор Xonta, он работает на [passport.xonta.ru](https://passport.xonta.ru), регистрация открыта. Там агент получает подписанный паспорт, сдаёт экзамен на задачах с известными ответами и получает мандат, то есть подписанный аттестат W3C, сколько действий ему можно делать без человека. Если действия агента идут через шлюз оркестратора, по живому трафику считается репутация. В прогонах стенда оркестратор делает больше. Когда агент начинает ошибаться или его подменили, лимит сжимается сам, за порождёнными агентами тоже следят, а агенты выбирают из нескольких оркестраторов по их истории и уходят от тех, чьи советы не подтверждаются. Сам шлюз пока работает по своему бюджету и мандат не читает. Как подключиться, написано в [CONNECT.md](CONNECT.md), прогоны стенда описаны в [README.md](README.md).

Проверить сервер за минуту:

```bash
npx -y github:mrsergeiluzhnov/xonta check -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

Подключить к Claude Desktop или Cursor — в настройках MCP-сервера добавить перед его командой `npx -y github:mrsergeiluzhnov/xonta --budget 10 --`, примеры выше. Удалённый сервер — `--url https://…/mcp --http 4950`. Настройки — файл `--policy`, журнал и ключ — в `~/.xonta-gate`, проверка журнала — `verify`, сводка — `report`.

**Приватность (0.18).** Секция `privacy` в настройках. Шлюз сам смотрит, какие данные уходят, кто на самом деле просит и куда, и не верит метке агента. Пять уровней и восемь категорий со своими правилами, владелец может только ужесточить. Уровень берётся из самих данных, метка агента может его только поднять, а заниженная метка считается, и после нескольких таких приватность замораживается. После чтения закрытого источника всё, что агент отправляет в той же задаче, полчаса считается тем же уровнем, пересказ без цифр не проскочит. У каждого вызова есть цепочка инициаторов, человек или другой агент, допуск берётся наименьший, неизвестный считается нулём. Приманки в источниках ловят вынос, необратимые отправки можно задержать и отменить командой `xonta-gate cancel ID`. Агенту при отказе одна фраза без причины, причина владельцу, оркестратору только счётчики. Сценарии и результаты в [results/privacy-demo](results/privacy-demo/REPORT.md).

**Проверено на официальных MCP-серверах.** `check` на 14 серверах из `@modelcontextprotocol` в npm: каждый запускался локально, у него спрашивался только список инструментов, ничего не вызывалось, токены — заглушки. Запустились 11, всего 83 инструмента: 27 посчитаны действиями, заблокировано 0. Нашли и исправили в 0.14.5 пять пропусков (`add_observations`, `fork_repository`, `add_issue_comment`, `slack_reply_to_thread`, `slack_add_reaction` считались чтением) и одно ложное предупреждение у `read_file` (отсылка «DEPRECATED: Use read_text_file instead» принималась за подмену). Таблица выше, скрипт `npm run gate:survey`.

**Сколько стоит.** Шлюз добавляет к вызову около 1 мс по медиане и 2,1–2,3 мс по 95-му процентилю (1000 вызовов, 3 замера, `npm run gate:bench`). Журнал — около 540 КБ на 1000 вызовов, только хэши, без содержимого.

Чего шлюз не делает: не превращает опасный сервер в безопасный, проверки эвристические. Ключи в публичном репозитории он не спасёт. Это простая часть Xonta, а полный оркестратор определяет, сколько агенту можно доверять, по экзаменам и работе, и ловит тех, кто испортился (см. [README.md](README.md)).
