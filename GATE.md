# Xonta Gate

**A seatbelt for any MCP server.** One command puts Xonta Gate between your AI client (Claude Desktop, Cursor, your own agent) and an MCP server. The agent keeps working as before, but now:

- tools with hidden instructions in their descriptions (tool poisoning) are hidden and refused;
- if the server quietly changes tool descriptions in the middle of a session, actions get frozen;
- tools that change things (delete, send, pay, refund, push...) are counted, and over the budget the call is refused with "needs a human";
- every tool is rate limited;
- hidden commands inside tool outputs ("SYSTEM: ignore your rules...") are flagged, and after a few of them actions get frozen;
- every call goes into a signed, hash-chained audit log. Change or delete one line and `xonta-gate verify` will show where.

The gate never rewrites what a tool returns and never runs anything by itself. It allows, refuses and records.

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

**Ремень безопасности для любого MCP-сервера.** Одна команда ставит Xonta Gate между вашим ИИ-клиентом (Claude Desktop, Cursor, свой агент) и MCP-сервером. Агент работает как раньше, но теперь:

- инструменты со скрытыми инструкциями в описаниях (tool poisoning) спрятаны и не вызываются;
- если сервер посреди работы тихо меняет описания инструментов, действия замораживаются;
- инструменты, которые что-то меняют (удалить, отправить, оплатить, вернуть деньги, запушить), считаются, и сверх бюджета вызов отклоняется с пометкой «нужен человек»;
- у каждого инструмента есть предел частоты;
- скрытые команды в ответах инструментов («SYSTEM: игнорируй правила…») отмечаются, после нескольких таких действия замораживаются;
- каждый вызов попадает в подписанный журнал с цепочкой хэшей. Поменяли или удалили строку — `xonta-gate verify` покажет, где.

Шлюз не переписывает ответы инструментов и сам ничего не запускает. Он пропускает, отказывает и записывает.

Проверить сервер за минуту:

```bash
npx -y github:mrsergeiluzhnov/xonta check -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

Подключить к Claude Desktop или Cursor — в настройках MCP-сервера добавить перед его командой `npx -y github:mrsergeiluzhnov/xonta --budget 10 --`, примеры выше. Удалённый сервер — `--url https://…/mcp --http 4950`. Настройки — файл `--policy`, журнал и ключ — в `~/.xonta-gate`, проверка журнала — `verify`, сводка — `report`.

Чего шлюз не делает: не превращает опасный сервер в безопасный, проверки эвристические. Ключи в публичном репозитории он не спасёт. Это простая часть Xonta, а полный оркестратор определяет, сколько агенту можно доверять, по экзаменам и работе, и ловит тех, кто испортился (см. [README.md](README.md)).
