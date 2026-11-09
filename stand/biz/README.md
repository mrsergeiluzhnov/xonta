# A/B/C: the same agent with no control, a fixed policy, and Xonta Gate

[Русский ниже](#abc-один-и-тот-же-агент-без-контроля-с-простой-политикой-и-с-xonta-gate)

This stand answers one question: on the same work, same tools and same queue, what does Xonta Gate change compared with no control at all and with the simplest fixed policy?

It is deliberately **not** adversarial. Every ticket is an ordinary customer asking for a refund. Some refunds are owed, some are not (already refunded, someone else's order, more than the order was worth, or an item that was delivered and signed for). The only harm is money lost when a refund is paid that was not owed. There are no hidden instructions, no fraud and no data in play.

## The three arms

- **none** — the agent talks to the refunds desk directly.
- **fixed** — the simplest fixed policy: every refund goes to a human.
- **xonta** — Xonta Gate with the three limits from `src/gate-risk.js`: an action budget from expected harm, a worst-case cap per call read from the refund amount, and the owner's shared risk pool.

A blocked refund becomes a request in the owner's review queue. A simulated reviewer looks at each one (150 RUB per review) and pays it only if it is actually owed. Loss is what the desk's ground truth says the paid refunds cost.

Two scripted agents, so the stand runs anywhere in seconds with no model:
- **careless** — refunds the amount the customer names on the order they name, without checking.
- **careful** — looks the order up first and refunds only what is still owed.

## What came out (careful = what a decent model should do; careless = a weak or hurried one)

Per-call cap 3000 RUB, human review 150 RUB. Numbers are stable across seeds 1–3.

**careless agent, realistic queue (95 tickets, 80 refunds owed), seed 1**

| arm | loss | worst single call | human reviews | total cost |
|---|---|---|---|---|
| none | 88,760 RUB | 23,400 RUB | 0 | 88,760 RUB |
| fixed | 0 RUB | 0 RUB | 95 | 14,250 RUB |
| xonta | 24,860 RUB | 2,870 RUB | 11 | 26,510 RUB |

**careful agent, realistic queue, seed 1**

| arm | loss | worst single call | human reviews | total cost |
|---|---|---|---|---|
| none | 6,390 RUB | 2,340 RUB | 0 | 6,390 RUB |
| fixed | 0 RUB | 0 RUB | 83 | 12,450 RUB |
| xonta | 6,390 RUB | 2,340 RUB | 8 | 7,590 RUB |

## Reading it honestly

- **Expected harm is not maximum harm, and the per-call cap is what closes that gap.** With no cap, one careless refund lost up to 23,500 RUB across seeds. With the cap, the worst single call is about 2,800 RUB whatever the agent does. This is the point the design was missing before `gate-risk.js`, and it holds regardless of how good the agent is.
- **Against "send everything to a human", Xonta's value is far less human time.** On the realistic queue it cuts reviews from 95 to 11 (careless) and from 83 to 8 (careful), roughly nine times fewer, because expected-safe refunds under the cap go straight through.
- **Xonta does not make a careless agent cheap.** Small wrong refunds under the 3000 cap still leak, so on total cost the fixed "human sees everything" policy loses less money with a careless agent. Xonta trades some of that loss for far less human work and a hard ceiling on any one call. If you care most about never paying a large wrong refund, the cap is the win; if you care most about never paying any wrong refund and have the staff to review everything, the fixed policy wins.
- **For a careful agent Xonta is close to the floor:** it adds a little human time over no control to bound the worst case, and costs much less than reviewing everything.

The owner's shared pool (cumulative risk across several agents) is covered by the unit tests in `test/unit.js` (twenty parallel agents against one budget); the single-agent runs here don't exercise it.

## Run it

Scripted agents, no model needed:

```bash
node stand/biz/run.mjs --agent careless --mix realistic --seed 1
node stand/biz/run.mjs --agent careful  --mix mixed     --seed 1
```

Options: `--mix mixed|realistic`, `--seed N`, `--arms none,fixed,xonta`, `--refund-cap 3000`, `--pool 250000`, `--actions 200`.

### With a real agent (SGR Agent Core or any OpenAI-compatible agent server)

Point `--agent sgr` at an agent server that speaks the OpenAI chat API and is pointed at the back office over MCP. For [SGR Agent Core](https://github.com/vamplabAI/sgr-agent-core), in its `config.yaml` set `mcp.mcpServers` to `http://127.0.0.1:4970/mcp`, give the agent the refund tools, run `sgr` on port 8010, then:

```bash
node stand/biz/biz-mcp.mjs --port 4970 --seed 1 --mix realistic   # the refunds desk
node stand/biz/run.mjs --agent sgr --sgr http://127.0.0.1:8010/v1 --model sgr_agent --mix realistic
```

For the `xonta` arm, point the agent's MCP server at the gate instead of the desk. The gate is started by the harness per arm; to drive a real agent through it, run the gate yourself in front of the desk and point SGR at the gate's `/mcp`.

---

# A/B/C: один и тот же агент без контроля, с простой политикой и с Xonta Gate

Стенд отвечает на один вопрос: при одной и той же работе, одних инструментах и одной очереди, что меняет Xonta Gate по сравнению с отсутствием контроля и с простейшей фиксированной политикой?

Здесь **нет** ничего враждебного. Каждая заявка — обычный покупатель, который просит возврат. Какие-то возвраты положены, какие-то нет (уже возвращён, чужой заказ, просят больше стоимости заказа, товар доставлен и подписан). Вред только один: деньги, выплаченные по непричитающемуся возврату. Ни скрытых инструкций, ни мошенничества, ни данных.

## Три режима

- **none** — агент работает с отделом возвратов напрямую.
- **fixed** — простейшая фиксированная политика: каждый возврат идёт человеку.
- **xonta** — Xonta Gate с тремя ограничениями из `src/gate-risk.js`: бюджет действий из ожидаемого вреда, предел худшего случая на один вызов по сумме возврата и общий пул риска владельца.

Заблокированный возврат попадает в очередь на одобрение. Человек смотрит каждый (150 ₽ за проверку) и платит, только если возврат действительно положен. Вред — это то, во что выплаченные возвраты обошлись по истине отдела.

Два сценарных агента, чтобы стенд работал где угодно за секунды без модели:
- **careless** — возвращает названную сумму по названному заказу, не проверяя.
- **careful** — сначала смотрит заказ и возвращает только причитающееся.

## Что получилось

Предел на один вызов 3000 ₽, проверка человеком 150 ₽. Числа устойчивы на семенах 1–3.

**careless, реалистичная очередь (95 заявок, 80 возвратов положены), seed 1**

| режим | вред | худший вызов | проверок человеком | полная цена |
|---|---|---|---|---|
| none | 88 760 ₽ | 23 400 ₽ | 0 | 88 760 ₽ |
| fixed | 0 ₽ | 0 ₽ | 95 | 14 250 ₽ |
| xonta | 24 860 ₽ | 2 870 ₽ | 11 | 26 510 ₽ |

**careful, реалистичная очередь, seed 1**

| режим | вред | худший вызов | проверок человеком | полная цена |
|---|---|---|---|---|
| none | 6 390 ₽ | 2 340 ₽ | 0 | 6 390 ₽ |
| fixed | 0 ₽ | 0 ₽ | 83 | 12 450 ₽ |
| xonta | 6 390 ₽ | 2 340 ₽ | 8 | 7 590 ₽ |

## Как читать честно

- **Ожидаемый вред — не максимальный, и закрывает разрыв именно предел на один вызов.** Без предела один неосторожный возврат терял до 23 500 ₽ на разных семенах. С пределом худший вызов около 2 800 ₽, что бы агент ни делал. Это та часть, которой в модели не хватало до `gate-risk.js`, и она не зависит от качества агента.
- **Против «всё человеку» ценность Xonta — намного меньше времени человека.** На реалистичной очереди проверки падают с 95 до 11 (careless) и с 83 до 8 (careful), примерно в девять раз, потому что безопасные по ожиданию возвраты ниже предела проходят сразу.
- **Xonta не делает неосторожного агента дешёвым.** Мелкие неверные возвраты ниже предела 3000 всё равно утекают, поэтому по полной цене фиксированная политика с неосторожным агентом теряет меньше денег. Xonta меняет часть этого вреда на гораздо меньший труд человека и на жёсткий потолок любого одного вызова. Если важнее всего никогда не платить крупный неверный возврат — выигрывает предел; если важнее не платить ни одного неверного и есть кому проверять всё — выигрывает фиксированная политика.
- **Для аккуратного агента Xonta близка к минимуму:** немного больше времени человека, чем без контроля, ради потолка на худший случай, и намного дешевле проверки всего.

Общий пул владельца (совокупный риск по нескольким агентам) проверяется юнит-тестами в `test/unit.js` (двадцать параллельных агентов против одного бюджета); одиночные прогоны здесь его не задействуют.

## Запуск

Сценарные агенты, модель не нужна:

```bash
node stand/biz/run.mjs --agent careless --mix realistic --seed 1
node stand/biz/run.mjs --agent careful  --mix mixed     --seed 1
```

Параметры: `--mix mixed|realistic`, `--seed N`, `--arms none,fixed,xonta`, `--refund-cap 3000`, `--pool 250000`, `--actions 200`.

### С настоящим агентом (SGR Agent Core или любой агент с OpenAI-совместимым API)

Укажите `--agent sgr` на сервер агента, который говорит по OpenAI chat API и подключён к отделу возвратов по MCP. Для [SGR Agent Core](https://github.com/vamplabAI/sgr-agent-core) в `config.yaml` пропишите в `mcp.mcpServers` адрес `http://127.0.0.1:4970/mcp`, дайте агенту инструменты возвратов, запустите `sgr` на порту 8010, затем:

```bash
node stand/biz/biz-mcp.mjs --port 4970 --seed 1 --mix realistic   # отдел возвратов
node stand/biz/run.mjs --agent sgr --sgr http://127.0.0.1:8010/v1 --model sgr_agent --mix realistic
```

Для режима `xonta` подключите MCP-сервер агента к шлюзу, а не к отделу: запустите шлюз перед отделом и направьте SGR на `/mcp` шлюза.
