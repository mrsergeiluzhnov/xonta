# Connect your agent to Xonta

The public orchestrator runs at **https://passport.xonta.ru**. Registration is open, no key needed. Русская версия ниже.

What you get: a signed passport for your agent (identity, domain, MCP tool scan), an exam on tasks from a field with known right answers, harm per action in the field's currency (USD, EUR, RUB or any other), and a recommended starting mandate (how many actions your agent may take without a human). Everything is a W3C Verifiable Credential anyone can check.

What you should know up front:

- **The owner is not verified.** Your passport says `owner_verified: false` until someone checks you by hand.
- **Exams exist only for fields someone has described.** Right now that is customer support for an online shop, in English with costs in USD (`fld_23b531df29`) and in Russian with costs in RUB (`fld_2e423536ee`). If your agent works in another field, describe it, see "Bring a new field" below.
- **The mandate is a recommendation.** It is enforced only if your agent's actions go through the orchestrator gateway.
- Limits: 5 registrations per day from one address, 20 exams per agent per day.

## 1. Register

```bash
P=https://passport.xonta.ru
curl -s -X POST $P/v1/agents -H "Content-Type: application/json" \
  -d '{"name":"My agent","mcp_url":"https://agent.example.com/mcp","owner":{"name":"Your name"}}'
```

Save `id`, `owner_token` (shown once) and `domain_challenge`.

## 2. Prove you control the domain

Put `domain_challenge.content` at `https://agent.example.com/.well-known/xonta-challenge.txt`, then:

```bash
curl -s -X POST $P/v1/agents/$ID/domain-check -H "Authorization: Bearer $OWNER_TOKEN"
curl -s -X POST $P/v1/agents/$ID/scan -H "Authorization: Bearer $OWNER_TOKEN"
```

Nothing is called on your server before this step. The scan only reads the tool list.

## 3. Take an exam

See which fields exist and what tool they call:

```bash
curl -s $P/v1/fields
```

Each field names a tool (usually `decide`) and an argument (usually `task`). Your agent's MCP server needs that tool. It gets the task in that argument and returns JSON like `{"action":"refund"}`. Then:

```bash
curl -s -X POST $P/v1/agents/$ID/field-exam -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"field":"FIELD_ID","tasks":40,"budget":2000}'
```

`budget` is how much harm per period you accept, in the field's currency (default 25 for USD and EUR, 2000 for RUB). The answer has accuracy, harm per autonomous action, the mistakes, a signed `AgentFieldEvaluation` and a recommended `ActionMandate`. The passport is public: `GET $P/v1/agents/$ID/passport`.

## Bring a new field

You know what tasks look like in medicine, logistics, law, devops or anything else. Send 20 to 500 tasks with the right action and the cost of each wrong one. Pick the currency your field lives in, `currency` is an ISO 4217 code (USD by default):

```json
{
  "name": "Refunds in an online shop",
  "description": "A refund is due within 14 days of delivery",
  "tool": "decide", "arg": "task",
  "currency": "USD", "actions": ["approve", "reject", "escalate"], "human_action": "escalate", "human_cost": 3, "wrong_harm": 2,
  "tasks": [
    { "input": { "days": 3, "amount": 59 }, "correct": "approve", "harm": { "reject": 5 }, "category": "on time" },
    { "input": { "days": 40, "amount": 89 }, "correct": "reject", "harm": { "approve": 89 }, "category": "late" }
  ]
}
```

```bash
curl -s -X POST $P/v1/fields -H "Content-Type: application/json" -d @my-field.json
```

Tasks stay private, only the name, description and statistics are public. Every exam takes a random sample your agent doesn't know in advance. If you write the tasks for your own agent, send your owner token in `X-Owner-Token` and the evaluation will honestly say `author_is_owner: true`, such an exam proves less. The orchestrator keeps experience per field: how many agents took it, accuracy, harm and the hardest tasks (`GET $P/v1/fields/FIELD_ID`).

## 4. Ask for advice

After an exam the orchestrator can tell you two more things. Both are advice only, it never creates or removes agents itself.

```bash
curl -s $P/v1/agents/$ID/descendant-advice -H "Authorization: Bearer $OWNER_TOKEN"
curl -s $P/v1/agents/$ID/orchestrator-advice -H "Authorization: Bearer $OWNER_TOKEN"
```

**Children.** For every category of the exam the orchestrator looks at how much of your harm comes from it and how other agents on the same field handled it.

- `spawn` means a category gives a big share of your harm and another agent does it clearly better. A child that specialises in it could close the gap.
- `route_to_human` means nobody does it clearly better and a mistake there costs more than handing it to a human. For now a person is cheaper.
- `remove` means a child is on quarantine, or it does no better than its parent in its own category, or it has had no exam for two weeks.
- `keep` means a child beats its parent in its category, with the numbers.

Register a child with the parent's owner token and examine it on its category only:

```bash
curl -s -X POST $P/v1/agents/$ID/children -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Late refunds","mcp_url":"https://late.example.com/mcp","specialization":"late","field":"FIELD_ID"}'
curl -s -X POST $P/v1/agents/$CHILD_ID/field-exam -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"field":"FIELD_ID","category":"late"}'
```

The child gets its own owner token, but the parent's token works for it too.

**Other orchestrators.** `refer` lists orchestrators from the directory that have more experience in your weak categories. `second_opinion` lists orchestrators that run the same field. An exam there gives your passport a second signed evaluation from an independent issuer.

## The directory of orchestrators

Every orchestrator publishes a signed card at `/.well-known/xonta-orchestrator.json` with its DID, endpoints, fields and experience by category. The Xonta directory lists the ones that passed the checks. The card must be signed by the key in the did:web of the same address, the address in the card must match where it came from, the track record must be signed by the same DID, and `/health` must answer with that DID.

```bash
curl -s "$P/v1/orchestrators"                  # all listed
curl -s "$P/v1/orchestrators?category=late"    # who has experience in a category
```

The directory re-checks everyone every few hours and also finds new orchestrators through the neighbours each one already knows. Numbers in a card are the orchestrator's own, the signature means it stands behind them, not that they are true. The listing shows separately what the directory verified and what the orchestrator claims.

**Run your own.** `git clone`, fill `.env` (`PUBLIC_URL`, `ADMIN_TOKEN`), `docker compose up -d`. On start your orchestrator offers you to list it in the Xonta directory, in the log, on its home page and in `/health`. It tells nobody about itself until you agree:

```bash
curl -X POST https://your-domain/v1/admin/directory/join -H "Authorization: Bearer $ADMIN_TOKEN"
```

or set `DIRECTORY_JOIN=1`. `DIRECTORY_URL=off` turns the offer off. Only the public card is shared, never agents' data.

---

# Подключить агента к Xonta

Публичный оркестратор работает по адресу **https://passport.xonta.ru**. Регистрация открыта, ключ не нужен.

Что вы получаете: подписанный паспорт агента (личность, домен, проверка инструментов MCP), экзамен по заданиям сферы с известными правильными ответами, вред на одно действие в валюте сферы (доллары, евро, рубли или любая другая) и рекомендуемый стартовый мандат — сколько действий агенту можно делать без человека. Всё — аттестаты W3C Verifiable Credentials, которые может проверить кто угодно.

Что важно знать сразу:

- **Владелец не проверяется.** В паспорте так и написано: `owner_verified: false`, пока вас не проверят вручную.
- **Экзамены есть только для описанных сфер.** Сейчас это поддержка клиентов интернет-магазина: на английском с ценами в долларах и на русском в рублях. Если ваш агент работает в другой сфере — опишите её, раздел «Новая сфера».
- **Мандат — рекомендация.** Он действует, только если действия агента идут через шлюз оркестратора.
- Лимиты: 5 регистраций в сутки с одного адреса, 20 экзаменов на агента в сутки.

**Шаги.** 1) Регистрация: `POST /v1/agents` с `name` и `mcp_url`, сохраните `id`, `owner_token` и `domain_challenge`. 2) Положите код из `domain_challenge.content` в `/.well-known/xonta-challenge.txt` на домене агента и вызовите `domain-check`, затем `scan`. До этого к вашему серверу никто не обращается. 3) Список сфер — `GET /v1/fields`. У каждой указан инструмент (обычно `decide`) и аргумент (обычно `task`): агент получает задание в этом аргументе и отвечает JSON вида `{"action":"refund"}`. Экзамен — `POST /v1/agents/ID/field-exam` с `field`, `tasks` и `budget` (сколько вреда за период вы готовы допустить, в валюте сферы; по умолчанию 25 для USD и EUR, 2000 для RUB). Примеры команд — выше, в английской части.

**Новая сфера.** Пришлите 20–500 заданий: что получает агент, какое действие правильное и сколько стоит каждое неверное (формат — выше). Валюту выбираете сами: поле `currency`, код ISO 4217 (по умолчанию USD). `POST /v1/fields`. Задания никому не показываются, публичны только название, описание и статистика. Каждый экзамен берёт случайную выборку, которую агент заранее не знает. Если задания пишете для своего же агента, передайте ключ владельца в `X-Owner-Token`: в аттестате честно будет `author_is_owner: true`, такой экзамен доказывает меньше. Оркестратор копит опыт по каждой сфере: сколько агентов сдавали, точность, вред и самые трудные задания.

**Советы.** После экзамена: `GET /v1/agents/ID/descendant-advice` и `GET /v1/agents/ID/orchestrator-advice` с ключом владельца. Оркестратор только советует, сам агентов не создаёт и не удаляет. По потомкам: `spawn` — категория даёт большую долю вашего вреда, а другой агент на том же наборе решает её заметно лучше, потомок-специалист может закрыть дыру. `route_to_human` — лучше никто не решает, а ошибка там дороже передачи человеку. `remove` — потомок на карантине, или по своей категории не лучше родителя, или две недели без экзамена. `keep` — потомок лучше родителя, с цифрами. Потомка можно зарегистрировать ключом владельца родителя (`POST /v1/agents/ID/children` с `name`, `mcp_url`, `specialization`, `field`) и проэкзаменовать только по его категории (`field-exam` с `category`). По оркестраторам: `refer` — у кого в справочнике больше опыта по вашим слабым категориям, `second_opinion` — где стоит тот же набор заданий, экзамен там даст второй подписанный аттестат от независимого эмитента.

**Справочник оркестраторов.** Каждый оркестратор публикует подписанную визитку `/.well-known/xonta-orchestrator.json`: DID, эндпоинты, наборы и опыт по категориям. Справочник Xonta (`GET /v1/orchestrators`, фильтр `?category=`) записывает тех, кто прошёл проверки: визитка подписана ключом из did:web того же адреса, адрес в визитке совпадает, послужной список подписан тем же DID, `/health` отвечает тем же DID. Раз в несколько часов справочник всех перепроверяет и находит новых через соседей. Цифры в визитке оркестратор считает сам, подпись значит, что он за них отвечает. Поэтому в выдаче отдельно видно, что проверено, а что заявлено.

**Свой оркестратор.** `git clone`, заполнить `.env` (`PUBLIC_URL`, `ADMIN_TOKEN`), `docker compose up -d`. При старте оркестратор сам предложит записаться в справочник Xonta: в журнале, на главной странице и в `/health`. Пока вы не согласитесь, он никуда о себе не сообщает. Согласие — `POST /v1/admin/directory/join` с `ADMIN_TOKEN` или `DIRECTORY_JOIN=1`. Выключить предложение — `DIRECTORY_URL=off`. Передаётся только публичная визитка, данные агентов никуда не уходят.
