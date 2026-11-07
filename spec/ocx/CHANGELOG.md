# Changelog / Журнал изменений

## Reference implementation, 2026-11-07

- Fix: a window proof for an empty window after the agent's last receipt (or before its first) left the edge receipt out, so a correct proof failed with "empty window not proven". Found in bench run run-ocx-1, where 6 of 18 valid signals were rejected this way. A new check, 35 in total. The specification text is unchanged.

Русским языком:

- Исправлено: доказательство пустого окна после последней квитанции агента (или до первой) не содержало крайней квитанции, и верное доказательство не проходило проверку («empty window not proven»). Нашлось в прогоне стенда run-ocx-1: так отклонены 6 из 18 верных сигналов. Новая проверка, всего 35. Текст спецификации не менялся.

## 0.2.1 (2026-11-06)

- The draft is open: specification, schemas and reference implementation are published in the Xonta repository.
- `ocx/status.query` answers list the answering orchestrator's own signals too (§8.5). A new check for it (34 in total).
- Limits in the reference implementation are configurable instead of a hard-coded 100 USD.
- First bench run on two orchestrators: `stand/ocx-run.js` in the Xonta repository.

Русским языком:

- Черновик открыт: спецификация, схемы и эталонная реализация лежат в репозитории Xonta.
- Ответ на `ocx/status.query` перечисляет и собственные сигналы отвечающего (§8.5), к этому добавлена проверка (всего 34).
- Пределы лимитов в эталонной реализации задаются при создании, а не зашиты как 100 долларов.
- Первый прогон стенда на двух оркестраторах: `stand/ocx-run.js` в репозитории Xonta.

## 0.2 (2026-11-06)

- Renamed from OCP to **OCX, Orchestrator Conduct Exchange**: the acronym OCP is already used by several agent protocols. Methods are now `ocx/...`, headers `OCX-Protocol-Version` and `OCX-Sender`, schema ids `urn:ocx:schema:2026-11-06:...`.
- Referral to a more specialised orchestrator (§10.10–10.12) and competence per category, kept separate from issuer weight (§12.2).
- `ocx/evidence.get` is served to any orchestrator with a signed request and a resolvable card, not only to peers, so relayed signals stay verifiable (§9.5).
- Issuer weight uses the operator's starting trust as the prior (§12.1).
- Schemas for referral tokens, referral outcomes and appeals; competence and roles in the card schema.
- Reference implementation of all five profiles (Core, Evidence, Experience, Referral, Appeal) with 33 checks, and `impl/conformance.mjs` to check any implementation from the outside.

Русским языком:

- Протокол переименован из OCP в **OCX, Orchestrator Conduct Exchange**: аббревиатура OCP уже занята несколькими протоколами для агентов. Методы теперь `ocx/...`, заголовки `OCX-Protocol-Version` и `OCX-Sender`.
- Направление агента к более профильному оркестратору и компетентность по категориям, отдельно от веса отправителя.
- Доказательства выдаются любому оркестратору с подписанным запросом, а не только соседям, чтобы пересланные сигналы оставались проверяемыми.
- Вес отправителя учитывает начальное доверие оператора.
- Схемы токена направления, исхода направления и апелляции.
- Эталонная реализация всех пяти профилей с 33 проверками и программа проверки чужих реализаций.

## 0.1 (2026-11-06)

First private draft: Orchestrator Card, peering, signals with evidence levels, receipts and ledger proofs, status queries, retraction, appeals, experience exchange with a required baseline, issuer weight, probes with consent, security and privacy considerations.

Первый закрытый черновик: карточка оркестратора, знакомство, сигналы с уровнями доказанности, квитанции и доказательства из журнала, запрос статуса, отзыв, апелляции, обмен опытом с обязательным сравнением, вес отправителя, проверки только с согласия, разделы о безопасности и приватности.
