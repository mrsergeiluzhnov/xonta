# OCX: эталонная реализация (черновик)

[English below](#ocx-reference-implementation-draft)

Открытый черновик, как и спецификация. Node 22, без внешних зависимостей. На этой реализации работает прогон стенда Xonta с двумя оркестраторами: [stand/ocx-run.js](../../../stand/ocx-run.js).

## Что есть

| Файл | Что делает | Раздел спецификации |
|---|---|---|
| `lib/crypto.js` | каноническая форма JSON (RFC 8785), ключи Ed25519 в виде JWK, отсоединённые подписи JWS, отпечаток ключа как идентификатор агента | §2.2, §8.1 |
| `lib/httpsig.js` | подписи запросов по RFC 9421 с Content-Digest (RFC 9530), окно 300 секунд, защита от повтора | §6.2 |
| `lib/merkle.js` | дерево Меркла и доказательства вхождения по RFC 9162 | §9.3 |
| `lib/ledger.js` | журнал квитанций, подписанные контрольные точки, индекс действий каждого агента, доказательство окна: какие квитанции агента есть за период и что других нет | §9.2, §9.3, §9.5 |
| `lib/orchestrator.js` | карточка оркестратора, знакомство с согласованием версии, доставка, пересылка и отзыв сигналов, запрос статуса, выдача доказательств, проверка доказательства у получателя, вес отправителя; обмен опытом, направление к профильному оркестратору и компетентность, апелляции | §5, §7, §10, §11, §12 |
| `test/core.test.mjs` | 18 проверок профилей Core и Evidence | §18 |
| `test/profiles.test.mjs` | 16 проверок профилей Experience, Referral и Appeal | §18 |

Запуск проверок: `node --test spec/ocx/impl/test/core.test.mjs spec/ocx/impl/test/profiles.test.mjs`. Сейчас проходят все 34.

## Проверка чужих реализаций

`conformance.mjs` проверяет любую реализацию OCX снаружи, так, как её видит сосед: поднимает маленький проверяющий оркестратор, знакомится с целью и прогоняет проверки профиля Core, а также Evidence, Experience, Referral и Appeal, если цель объявила их в карточке.

```bash
node spec/ocx/impl/conformance.mjs https://orch.example.com
TESTER_PUBLIC_URL=https://tester.example.com TESTER_PORT=7900 node spec/ocx/impl/conformance.mjs https://orch.example.com
```

Цель должна уметь достучаться до карточки проверяющего, поэтому для удалённой цели проверяющий запускается за публичным адресом. Результат пишется в `conformance-<хост>.json`. На эталонной реализации: 20 из 20.

## Что проверяется

- карточка лежит по адресу `.well-known` и содержит обязательные поля по схеме;
- знакомство симметричное, чужая версия протокола отклоняется с кодом -32012 и списком поддерживаемых;
- неподписанный запрос, повтор того же запроса и запрос, подписанный ключом не из карточки отправителя, отклоняются (-32011);
- сигнал от того, с кем нет знакомства, отклоняется (-32010);
- сигнал с изменённым полем отклоняется (-32021), просроченный (-32020), с петлёй или превышением числа пересылок (-32022);
- поля пересылки не входят в подпись, поэтому пересланный сигнал остаётся проверяемым;
- сигнал уровня `suspected` записывается, но не меняет лимиты и не пересылается;
- повторно присланный сигнал игнорируется;
- ответ о статусе подписан отвечающим и честно показывает, проверял ли он доказательство сам;
- доказательство окна в журнале показывает ровно квитанции за период и ловит выброшенную квитанцию, исправленную квитанцию, исправленный индекс и подделанную контрольную точку;
- отзыв сигнала принимается и пересылается дальше, даже если сам сигнал не пересылался;
- опыт без сравнения с простейшим правилом опубликовать нельзя; лучше агента, но не лучше простейшего правила — значит «без эффекта», а не «доказано»; пакет, объявленный доказанным без такого сравнения, и подделанный пакет отклоняются;
- получатель опыта перемеряет его на своих данных и хранит свой вывод: у отправителя «доказано», у получателя может быть «без эффекта»;
- направление: профильный оркестратор отказывает в чужой категории (-32040); токен подписан, в нём причина и связь между оркестраторами, вариант «остаться и взять опыт» предлагается, когда у цели есть доказанный опыт; токен одноразовый (-32041); направляющий честно пишет, что ещё не наблюдал цель;
- компетентность считается из исходов направлений, исходы по квитанциям весят больше, чем со слов агента; запрос компетентности отвечает только собственными наблюдениями и подписан; исход чужого направления не принимается;
- апелляцию может подать только владелец, указанный в сигнале, и только с его подписью; удовлетворённая апелляция отзывает сигнал у всех; на ответ 72 часа; просроченная апелляция видна как просроченная, и получатели снимают ограничения, введённые по такому сигналу.

## Чего пока нет

- переноса в оркестратор Xonta: квитанции на каждый вызов через шлюз и новая карточка рядом со старой `/.well-known/xonta-orchestrator.json`.

## Что поменялось в спецификации по итогам реализации

- `ocx/evidence.get` теперь обязан отвечать любому оркестратору с подписанным запросом и карточкой, а не только соседям: пересланный сигнал приходит к тем, кто с отправителем не знаком, и иначе они не смогли бы проверить доказательство (§9.5).
- Вес отправителя считается с начальным доверием оператора как априорным значением (§12.1). Тогда одного проверенного сигнала от незнакомого оркестратора мало, чтобы сразу снижать лимиты, а оркестратору, за которого оператор поручился, можно доверять сразу.
- Ответ на `ocx/status.query` перечисляет и сигналы, которые отвечающий выпустил сам, а не только полученные от соседей (§8.5). Раньше оркестратор, который сам поймал агента на вранье, отвечал «активных сигналов нет» и показывал только закрытые лимиты. Это нашлось, когда собирали прогон стенда. Отозванный сигнал из ответа пропадает, а свои лимиты агента открываются, только когда своих активных сигналов о нём не осталось.
- Пределы лимитов задаются при создании оркестратора (`openLimits`, `closedLimits`), раньше было жёстко 100 долларов. На стенде — рубли.

---

# OCX reference implementation (draft)

An open draft, like the specification. Node 22, no external dependencies. The Xonta test bench runs two orchestrators on it: [stand/ocx-run.js](../../../stand/ocx-run.js).

## What is here

| File | What it does | Spec section |
|---|---|---|
| `lib/crypto.js` | JSON canonicalisation (RFC 8785), Ed25519 keys as JWK, detached JWS, key thumbprint as agent id | §2.2, §8.1 |
| `lib/httpsig.js` | request signatures per RFC 9421 with Content-Digest (RFC 9530), 300 s window, replay protection | §6.2 |
| `lib/merkle.js` | Merkle tree and inclusion proofs per RFC 9162 | §9.3 |
| `lib/ledger.js` | receipt ledger, signed checkpoints, per-agent index, window proofs: which receipts an agent has in a period and that there are no others | §9.2, §9.3, §9.5 |
| `lib/orchestrator.js` | Orchestrator Card, peering with version negotiation, delivery, relay and retraction of signals, status queries, evidence serving, receiver-side evidence verification, issuer weight; experience exchange, referral and competence, appeals | §5, §7, §10, §11, §12 |
| `test/core.test.mjs` | 18 checks for the Core and Evidence profiles | §18 |
| `test/profiles.test.mjs` | 16 checks for the Experience, Referral and Appeal profiles | §18 |

Run: `node --test spec/ocx/impl/test/core.test.mjs spec/ocx/impl/test/profiles.test.mjs`. All 34 pass.

## Checking other implementations

`conformance.mjs` checks any OCX implementation from the outside, the way a peer sees it: it starts a small tester orchestrator, peers with the target and runs the Core checks, plus Evidence, Experience, Referral and Appeal if the target's card declares them.

```bash
node spec/ocx/impl/conformance.mjs https://orch.example.com
TESTER_PUBLIC_URL=https://tester.example.com TESTER_PORT=7900 node spec/ocx/impl/conformance.mjs https://orch.example.com
```

The target must be able to reach the tester's card, so for a remote target run the tester behind a public URL. Results go to `conformance-<host>.json`. Against the reference implementation: 20 of 20.

## What is checked

- the card is at the well-known path and has the required fields from the schema;
- peering is symmetric; an unknown protocol version is refused with -32012 and the supported list;
- unsigned requests, replays and requests signed with a key not in the sender's card are refused (-32011);
- a push from a non-peer is refused (-32010);
- a signal with an altered field is rejected (-32021), an expired one (-32020), one with a loop or too many hops (-32022);
- relay fields are outside the signature, so a relayed signal stays verifiable;
- a `suspected` signal is recorded but changes no limits and is not relayed;
- duplicates are ignored;
- status answers are signed and say honestly whether the answering orchestrator verified the evidence itself;
- ledger window proofs show exactly the receipts in a period and catch a dropped receipt, an edited receipt, an edited index and a forged checkpoint;
- a retraction is accepted and relayed even when the original signal was not relayed;
- experience cannot be published without a baseline; better than the agent but not than the baseline means "no effect", not "proven"; a package claiming proven without that, and a tampered package, are refused;
- the receiver re-measures experience on its own data and keeps its own verdict: proven at the sender may be no effect at the receiver;
- referral: a specialised orchestrator declines other categories (-32040); the token is signed, states the reason and the relationship, offers "stay and take the experience" when the target has proven experience, and is single-use (-32041); the referrer says honestly when it has not yet observed the target;
- competence comes from referral outcomes, with outcomes based on receipts counting more than self-reports; competence queries answer only from own observations and are signed; an outcome about someone else's referral is refused;
- only the owner named in a signal can appeal, with the owner's signature; an upheld appeal retracts the signal everywhere; the issuer has 72 hours; an overdue appeal shows as overdue and receivers lift limits imposed because of that signal.

## Not yet

- integration into the Xonta orchestrator: receipts for every call through the gateway and the new card next to the old `/.well-known/xonta-orchestrator.json`.

## Spec changes that came out of implementing it

- `ocx/evidence.get` must now be served to any orchestrator with a signed request and a resolvable card, not only to peers: relayed signals reach orchestrators that do not know the issuer, and they could not verify the evidence otherwise (§9.5).
- Issuer weight uses the operator's starting trust as the prior (§12.1). One verified signal from an unknown orchestrator is then not enough to lower limits at once, while an orchestrator the operator vouches for can be acted on immediately.
- An `ocx/status.query` answer now lists the signals the answering orchestrator issued itself, not only the ones it received from peers (§8.5). Before, an orchestrator that caught an agent lying itself answered "no active signals" and only showed closed limits. We found this while building the bench run. A retracted signal drops out of the answer, and the agent's own limits reopen only when no own active signal about it is left.
- Limits are set when the orchestrator is created (`openLimits`, `closedLimits`) instead of a hard-coded 100 dollars. The bench uses rubles.
