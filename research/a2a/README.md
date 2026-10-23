# Приглашения агентам A2A

[English below](#inviting-a2a-agents)

Xonta ищет агентов A2A в открытом реестре и приглашает подходящих подключиться. Сначала только чтение, отправка отдельно и только по списку, который владелец эксперимента одобрил сам.

1. `node research/a2a/discover.mjs ./a2a-data` - список из реестра [a2aregistry.org](https://a2aregistry.org) (свой - `A2A_REGISTRY`) и публичные карточки агентов. Сообщений не отправляет. Выход: `SUMMARY.md` (сводные цифры, можно публиковать) и `candidates.json` (чужие агенты с оценкой, не публиковать).
2. Подходящими считаются агенты с читаемой карточкой, открытым входом JSON-RPC по https без авторизации и навыками про агентов (оркестрация, оценка, доверие, реестры, платежи агентов). Отдельно отмечены те, кто прямо пишет, что открыт к контакту.
3. Из `candidates.json` владелец сам выписывает адреса карточек в `approved.txt`.
4. `node research/a2a/invite.mjs ./a2a-data approved.txt` - пробный запуск, показывает сообщения. `A2A_SEND=1` - отправка.

Правила рассылки: одно сообщение на агента и никогда повторно (журнал `sent.jsonl`), не больше `A2A_SEND_MAX` (20) за запуск, пауза 5 секунд, в каждом сообщении сказано, кто пишет и что это скрипт, и как отказаться (STOP). Отказавшиеся попадают в `optout.txt` и в список оркестратора. Ответы, пришедшие позже, видны в `GET /v1/admin/a2a/inbox`.

У самого оркестратора есть карточка A2A (`/.well-known/agent-card.json`, версия 1.0 и поля для клиентов до 1.0) и вход `/a2a` (SendMessage и message/send): на любое сообщение он отвечает, как подключиться, на STOP - заносит отправителя в отказ.

---

# Inviting A2A agents

Xonta finds A2A agents in an open registry and invites the relevant ones to connect. Discovery is read-only; sending is a separate step and only to a list the experiment owner approved by hand.

`discover.mjs` reads the registry ([a2aregistry.org](https://a2aregistry.org) by default) and public agent cards and writes `SUMMARY.md` (aggregate, publishable) and `candidates.json` (third-party agents, keep private). `invite.mjs` is a dry run by default; `A2A_SEND=1` sends one message per approved agent, never twice, at most 20 per run, saying who we are, that a script sent it, and how to opt out (STOP). The orchestrator itself publishes an A2A card and answers `SendMessage` / `message/send` at `/a2a`.
