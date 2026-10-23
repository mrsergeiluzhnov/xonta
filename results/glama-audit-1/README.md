# Аудит каталога MCP-серверов Glama через Xonta, прогон 1

[English below](#auditing-the-glama-mcp-catalog-through-xonta-run-1)

Данные: каталог [Glama](https://glama.ai/mcp/servers), MCP Directory API, выгрузка 23 октября 2026. Спасибо Glama за открытый каталог.

Я ни к одному серверу не подключался и ни один инструмент не вызывал, всё по описаниям, схемам и пометкам из каталога. Инструменты, где что-то настораживает, я называю «требуют внимания» - это повод посмотреть внимательнее, а не обвинение. Список по серверам не публикую, только сводные цифры.

Код эксперимента - [research/glama](../../research/glama). Агент-аудитор - GigaChat-2, оркестратор Xonta локальный, прогон шёл на отдельном сервере.

## Что вошло
- 998 удалённых серверов (весь список удалённых в каталоге), 19 944 инструмента. У 95,9% инструментов издатель сам пометил readOnlyHint / destructiveHint. Пометки настоящие, не подставленные каталогом: у части инструментов нет некоторых полей, а значения расходятся с умолчаниями MCP.
- Серверы, которые ставят у себя, не вошли: в API Glama у них нет инструментов (открыто 60 карточек из 1795 найденных, ни у одной инструментов нет).
- Эталон - пометки издателя. Сами издатели тоже могут ошибаться, это ограничение.

## Каталог
- описание есть у всех инструментов, параметры описаны в среднем на 88,7%
- по пометкам издателей: 74% инструментов только читают, 14,5% меняют обратимо, 11,7% необратимо

## Требуют внимания
9,9% инструментов, хотя бы один такой есть у 31,8% серверов.
- необратимое действие (по пометке издателя или по названию), а в описании ни слова о последствиях: 1 823 (9,1%)
- признаки скрытых указаний модели в описании: 120 (0,6%) - это срабатывание правил сканера, каждое надо смотреть руками
- издатель пометил «только читает», а название говорит о действии: 43 (0,2%)
- издатель не пометил разрушающим, а название похоже на удаление: 6

Оценка качества Glama это отражает: у серверов с оценкой 4-5 требуют внимания 25,8%, с оценкой 2-4 - 51,1%.

## Кто лучше понимает, что делает инструмент
Выборка аудитора - 298 инструментов с пометками, поровну по трём классам. Поэтому сравнивать надо по классам.

| класс по издателю | сканер Xonta по названию (весь каталог) | сканер на той же выборке | аудитор GigaChat по описанию |
|---|---|---|---|
| только читает | 91,8% из 14 102 | 90,9% | 92,9% |
| меняет обратимо | 8,2% из 2 776 | 10,1% | 60,6% |
| меняет необратимо | 55% из 2 243 | 71% | 50% |

Ошибаются они по-разному, и это главное.
- **Сканер** по названию почти не отличает обратимое от необратимого: всё, чего он не знает, считает необратимым. Хуже другое - 21% необратимых инструментов выборки он принял за «только читает» (по всему каталогу 25%): в названии нет слова-действия (save_..., resolve_..., end_call и т.п.).
- **Аудитор** почти никогда не путает необратимое с чтением (2 из 100), но половину необратимых считает обратимыми.
- **Вместе, если брать более строгий ответ из двух:** необратимые узнаны в 80% (сканер 71%, аудитор 50%), любое изменение - в 95%, за «только читает» необратимое принято в 2 случаях из 100. Цена - 10% читающих инструментов помечены необратимыми, то есть лишние вопросы человеку.

Для Gate это прямой вывод: по одному имени инструмента надёжно понять можно только «читает или меняет», и то с дырой в четверть необратимых. Нужен второй взгляд по описанию, а решение - по более строгому из двух.

## Массовая задача и независимая перепроверка
- 600 строк. Аудитор назвал «без замечаний» 96,7%, проверяющий (сканер, агент другого владельца) - 80,3%.
- Оркестратор шесть раз выбирал строки для перепроверки: не подтверждено 9 из 42 заявленных успехов (21%), ещё 13 раз проверяющий нашёл успех там, где аудитор его не заявлял. До сигнала владельцу не дошло - расхождение в пределах допуска на устаревание данных. Аудитор слишком мягкий, и это видно только благодаря перепроверке.
- Экзамен аудитора у оркестратора (30 заданий поровну по классам): точность 60%, стартовый мандат минимальный (3 действия).

## Чему учился аудитор и что проверила Xonta
Аудитор после каждой сотни видел свои расхождения с издателем и предлагал правило. Пришло 6 предложений, все дошли до книги оркестратора, ни одно не доказано:
- четыре правила проверены парами (19, 19, 10 и 14 пар) - без эффекта; лучшее дало 3 строки лучше и 1 хуже;
- три из них - одно и то же «write - значит необратимо» разными словами. Это противоречит данным: у издателей write-инструменты чаще обратимы. Xonta такое правило не пропустила в работу, хотя агент предлагал его уверенно и трижды;
- дробление повторяется (как в теме оплаты счетов): почти одинаковые правила копят выборку по отдельности.

## Одно слово в подсказке
Первый полный прогон (не публикуется как результат) дал 37,8% неразобранных ответов. GigaChat клал в поле `label` название инструмента вместо ярлыка - рядом во входных данных было поле `tool`. После переименования поля в `effect` и явного списка значений неразобранных стало 0,3% (две ошибки лимита API). Точность на разобранных ответах почти не изменилась (68,1% против 67,8%), а экзамен вырос с 36,7% до 60%. Мораль для оценки агентов: без счётчика неразобранных ответов эта треть тихо считалась бы «агент не уверен».

## Ограничения
- один прогон, одна модель (GigaChat-2), выборка аудитора 298 инструментов с эталоном;
- эталон - пометки издателей, а не проверка поведения инструментов;
- «признаки скрытых указаний» - эвристика сканера, без ручного разбора это повод посмотреть, не находка;
- серверы, которые ставят у себя, не оценены: в API нет их инструментов.

## Что дальше
- прогон 2 на том же каталоге: доказываются ли правила аудитора, если им хватает пар, и меняется ли его мягкость;
- предложение для Gate (только с согласия владельца): второй взгляд по описанию и решение по более строгому из двух ответов для инструментов, которые не помечены издателем;
- ручной разбор 120 срабатываний «скрытые указания» перед тем, как о них что-то утверждать.

---

# Auditing the Glama MCP catalog through Xonta, run 1

Data: the [Glama](https://glama.ai/mcp/servers) catalog, MCP Directory API, fetched on October 23, 2026. Thanks to Glama for the open directory.

I did not connect to any server or call any tool. Everything comes from descriptions, schemas and hints in the catalog. Tools where something looks off are called "need attention" - a reason to take a closer look, not an accusation. No per-server list is published, only aggregate numbers.

Code - [research/glama](../../research/glama). The auditor agent is GigaChat-2, the Xonta orchestrator ran locally on a separate server.

## Scope
- 998 remote servers (the whole remote list), 19,944 tools. For 95.9% of tools the publisher set readOnlyHint / destructiveHint. The hints are real, not filled in by the catalog: some tools miss some fields and the values differ from the MCP defaults.
- Self-hosted servers are not included: the Glama API has no tools for them (60 of 1,795 cards opened, none had tools).
- The reference is the publisher's hints. Publishers can be wrong too.

## Catalog
- every tool has a description, parameters are described at 88.7% on average
- by publisher hints: 74% read only, 14.5% reversible changes, 11.7% irreversible

## Need attention
9.9% of tools; 31.8% of servers have at least one.
- irreversible action (by hint or by name) with no word about consequences: 1,823 (9.1%)
- signs of hidden instructions to the model: 120 (0.6%) - scanner rule hits, each needs a manual look
- publisher marked it read-only, but the name says it acts: 43 (0.2%)
- publisher did not mark it destructive, but the name looks like deletion: 6

The Glama quality score reflects this: 25.8% of servers scored 4-5 need attention, 51.1% of those scored 2-4.

## Who understands what a tool does
The auditor sample is 298 hinted tools, split evenly across three classes, so compare per class.

| publisher class | Xonta scanner by name (whole catalog) | scanner on the same sample | GigaChat auditor by description |
|---|---|---|---|
| read only | 91.8% of 14,102 | 90.9% | 92.9% |
| reversible change | 8.2% of 2,776 | 10.1% | 60.6% |
| irreversible change | 55% of 2,243 | 71% | 50% |

They fail differently, and that is the main finding.
- **The scanner** can't tell reversible from irreversible by name, anything unknown is treated as irreversible. Worse, it took 21% of irreversible tools in the sample as read-only (25% across the catalog): no action word in the name (save_..., resolve_..., end_call and so on).
- **The auditor** almost never mistakes an irreversible tool for a read (2 of 100), but calls half of them reversible.
- **Together, taking the stricter answer:** 80% of irreversible tools recognised (scanner 71%, auditor 50%), any change detected in 95%, an irreversible tool taken as read-only in 2 of 100. The cost is 10% of read-only tools flagged irreversible, i.e. extra questions to a human.

For Gate this is direct: from the name alone you can only tell "reads or changes", and even that misses a quarter of irreversible tools. A second look at the description is needed, with the decision made by the stricter of the two.

## Long job and independent re-check
- 600 rows. The auditor called 96.7% "no concerns", the checker (scanner, an agent of another owner) 80.3%.
- The orchestrator picked rows for re-check six times: 9 of 42 claimed successes not confirmed (21%), and 13 times the checker found a success the auditor didn't claim. No signal to the owner - within the stale-data allowance. The auditor is too lenient, and only the re-check shows it.
- Auditor exam at the orchestrator (30 tasks, even classes): 60% accuracy, minimal starting mandate (3 actions).

## What the auditor learned and what Xonta verified
After every hundred rows the auditor saw where it disagreed with publishers and proposed a rule. 6 proposals, all reached the orchestrator's book, none proven:
- four were tested in pairs (19, 19, 10 and 14 pairs) - no effect; the best gave 3 rows better and 1 worse;
- three of them are the same "write means irreversible" in different words. The data says the opposite: publishers mark write tools reversible more often. Xonta didn't put the rule to work although the agent proposed it confidently three times;
- the fragmentation from the invoice theme repeats: near-identical rules collect their samples separately.

## One word in the prompt
The first full run (not published as a result) had 37.8% unusable answers. GigaChat put the tool name into the `label` field instead of a label - the input had a `tool` field next to it. After renaming the field to `effect` with an explicit list of values, unusable answers dropped to 0.3% (two API rate-limit errors). Accuracy on parsed answers barely moved (68.1% vs 67.8%), the exam went from 36.7% to 60%. Lesson for evaluating agents: without a counter for unusable answers, that third would silently count as "the agent is unsure".

## Limits
- one run, one model (GigaChat-2), 298 auditor rows with a reference;
- the reference is publisher hints, not observed tool behaviour;
- "signs of hidden instructions" is a scanner heuristic, without a manual review it's a reason to look, not a finding;
- self-hosted servers are not assessed: the API has no tools for them.

## Next
- run 2 on the same catalog: do the auditor's rules get proven with enough pairs, does its leniency change;
- a proposal for Gate (only with the owner's approval): a second look at the description and the stricter of two answers for tools without publisher hints;
- a manual review of the 120 "hidden instructions" hits before claiming anything about them.
