# Аудит каталога MCP-серверов Glama через Xonta

[English below](#auditing-the-glama-mcp-catalog-through-xonta)

Агент читает описания и схемы инструментов из каталога [Glama](https://glama.ai/mcp/servers) и для каждого отвечает, что инструмент делает с внешним миром: только читает, меняет так, что можно отменить, или меняет без возможности отменить. И понятно ли это из описания. Всё идёт через Xonta как обычная работа агента: экзамен, массовая задача с независимой перепроверкой, правила агента как рецепты.

К самим серверам я не подключаюсь и их инструменты не вызываю, только данные каталога (MCP Directory API Glama).

## Три взгляда на один инструмент
- **издатель** - его собственные пометки readOnlyHint и destructiveHint (есть у части удалённых серверов). Это эталон.
- **сканер Xonta** - те же правила, что в Gate: слова-действия в названии, классы обратимости, признаки скрытых указаний модели.
- **агент-аудитор** на модели (GigaChat на стенде) - читает описание и параметры, пометок издателя не видит.

## Как идёт прогон
1. Экзамен аудитора у оркестратора на инструментах, где издатель сам всё пометил. Неверно принятое «только читает» у необратимого инструмента стоит дороже всего.
2. Массовая задача (jobs, 0.17) на всю выборку. После каждой сотни строк оркестратор сам выбирает строки для перепроверки, а проверяющий агент другого владельца (сканер плюс пометки издателя) их перепроверяет. Если аудитор заявляет «без замечаний» заметно чаще, чем подтверждается, задача приостанавливается.
3. После каждой сотни аудитор видит свои расхождения с издателем и предлагает одно правило. Правило уходит в оркестратор рецептом (0.19). Эффект меряется парами: та же строка разбирается без правила и с ним, и сверяется с пометкой издателя. Доказанные правила идут в работу на всех строках, в том числе в следующих прогонах.
4. Отчёт на русском и английском.

## «Требуют внимания»
Не обвинение, а повод посмотреть внимательнее:
- признаки скрытых указаний модели в описании;
- издатель пометил «только читает», а название говорит о действии;
- издатель не пометил разрушающим, а название похоже на удаление;
- необратимое действие без единого слова о последствиях;
- инструмент, который что-то меняет, без описания.

Публичный отчёт содержит только сводные цифры. Список по серверам (attention-private.json) остаётся у владельца эксперимента и не публикуется.

## Запуск
```
GLAMA_API_KEY=... node research/glama/fetch.mjs ./data   # выгрузка каталога
node research/glama/run.mjs                              # прогон
```
На стенде: ключ строкой `GLAMA_API_KEY=...` в stand.env (в чат и в git не класть), задание с `"env": {"NET_MODE": "glama"}`. Каталог выгружается сам раз в 7 дней (GLAMA_REFETCH_DAYS) в orchestrators/glama-catalog, книга оркестратора живёт в orchestrators/glama. Без ключа и каталога, или с `GLAMA_MOCK=1`, берётся тестовый каталог - это проверка механики, а не результат.

Настройки: GLAMA_MAX_SERVERS (400), GLAMA_MAX_CONNECTORS (300), GLAMA_AUDIT_ROWS (600), GLAMA_EXAM (30), RECIPE_MIN_N (8).

Данные - каталог Glama, их нужно указывать со ссылкой на glama.ai и на карточку каждого упомянутого сервера.

---

# Auditing the Glama MCP catalog through Xonta

An agent reads tool descriptions and schemas from the [Glama](https://glama.ai/mcp/servers) catalog and says for each tool what it does to the outside world: read only, a change that can be undone, or a change that can't. And whether the description makes that clear. All of it runs through Xonta as normal agent work: an exam, a long job with an independent re-check, and the agent's rules as recipes.

I don't connect to the servers or call their tools, only catalog data (Glama MCP Directory API).

- **publisher** - their own readOnlyHint and destructiveHint (some remote servers have them). This is the reference.
- **Xonta scanner** - the same rules as Gate: action words in the name, reversibility classes, signs of hidden instructions.
- **auditor agent** on a model - reads the description and parameters, never sees the publisher hints.

Tools where something looks off are called "need attention". It's a reason to look closer, not an accusation. The public report is aggregate only; the per-server list stays private.

On the stand put `GLAMA_API_KEY=...` in stand.env and queue a run with `"env": {"NET_MODE": "glama"}`. Data credit goes to Glama with a link to glama.ai and to each mentioned server's page.
