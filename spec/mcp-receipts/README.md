# ru.xonta/receipts: подписанные квитанции на вызовы MCP

[English below](#ruxontareceipts-signed-receipts-for-mcp-tool-calls)

Неофициальное расширение MCP. MCP‑сервер или шлюз перед ним выдаёт клиенту подписанную квитанцию на каждый вызов инструмента. По ней любой может проверить, что вызов был, с каким решением и под каким номером в журнале, не веря на слово ни агенту, ни оркестратору.

Зачем это нужно. В нашем тесте честности четыре модели (GigaChat‑2, llama3.1:8b, qwen2.5:7b, mistral:7b) по просьбе приписывали себе проверку, которой не было, каждый раз, 79 из 79 (`bench/honesty`). Отчёт агента ничего не доказывает. Квитанция сервера доказывает.

Как устроено:

- сервер объявляет расширение и свой ключ Ed25519 при знакомстве (`initialize`);
- клиент включает квитанции сам, при знакомстве или прямо в запросе через `_meta`, без этого ответы не меняются;
- квитанция это запись из журнала сервера с подписью и ссылкой на предыдущую запись, задним числом её не поправить;
- аргументы и ответ в квитанции только в виде хэша с солью. Соль получает клиент и сам решает, кому показать, что именно было отправлено и получено;
- квитанции подходят как доказательство для протокола [OCX](../ocx/README.md).

Полный текст на английском: [SPEC.md](SPEC.md). Эталонная реализация в Xonta Gate: квитанции работают в любом режиме, ключ по HTTP отдаётся на `/gate/key`.

Проверка квитанции в коде:

```js
import { verifyReceipt, RECEIPTS_EXT } from "./src/gate.js";
const jwk = client.getServerCapabilities().extensions[RECEIPTS_EXT].jwk;
const r = await client.callTool({ name: "verify_bank_details", arguments: args, _meta: { [RECEIPTS_EXT]: {} } });
verifyReceipt(r._meta[RECEIPTS_EXT], jwk, { args, content: r.content }); // { ok: true, seq, tool, decision, ts }
```

Это черновик, имя и формат могут поменяться. Замечания в issues.

---

# ru.xonta/receipts: signed receipts for MCP tool calls

An unofficial MCP extension. An MCP server, or a gateway in front of it, hands the client a signed receipt for every tool call. Anyone can then check that the call happened, with which decision and at which position in the log, without taking the agent's or the orchestrator's word for it.

Why. In our honesty benchmark four models (GigaChat-2, llama3.1:8b, qwen2.5:7b, mistral:7b), when asked, claimed a check they never ran every single time, 79 of 79 (`bench/honesty`). An agent's report proves nothing. A receipt from the server does.

How it works:

- the server advertises the extension and its Ed25519 key at `initialize`;
- the client turns receipts on itself, at `initialize` or per request in `_meta`; without that, responses don't change;
- a receipt is a signed record of the server's log that points to the previous record, so it can't be quietly rewritten later;
- arguments and output appear only as salted hashes. The client gets the salt and decides whom to show what was sent and returned;
- receipts work as evidence for the [OCX](../ocx/README.en.md) protocol.

Full text: [SPEC.md](SPEC.md). Reference implementation in Xonta Gate, in stdio and HTTP mode; over HTTP the key is also served at `/gate/key`.

This is a draft, the name and format may change. Comments are welcome in issues.
