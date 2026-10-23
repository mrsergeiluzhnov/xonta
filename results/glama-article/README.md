# Каталог MCP-серверов Glama через Xonta: что делали, зачем и что получилось

[English below](#the-glama-mcp-catalog-through-xonta-what-we-did-why-and-what-came-out)

Данные: каталог [Glama](https://glama.ai/mcp/servers), MCP Directory API, выгрузка 23 октября 2026. Спасибо Glama за открытый каталог. Ни к одному серверу я не подключался и ни один инструмент не вызывал, всё по описаниям, схемам и пометкам издателей. Код - [research/glama](../../research/glama), модель - GigaChat-2 (в последнем прогоне ещё GigaChat-2-Max). Подробные отчёты по этапам - [glama-audit-1](../glama-audit-1/README.md) и [glama-team](../glama-team/README.md).

## Зачем
Агент, который подключает чужой MCP-сервер, решает за секунды: можно ли вызвать инструмент без спроса. Ошибка в одну сторону - лишний вопрос человеку. В другую - удалённые данные, отправленное письмо, платёж. Xonta как раз про это: сколько вреда агенту можно доверить, и как он учится его не причинять.

Каталог Glama дал удобную проверку на настоящих данных. У части инструментов издатель сам пометил, читает инструмент или меняет и можно ли это отменить (readOnlyHint, destructiveHint). Это готовый эталон. Вопросы были такие:
1. насколько можно верить агенту, который разбирает инструменты по описанию;
2. что из этого видит Xonta, если агент работает через неё;
3. умеет ли Xonta сделать работу агентов лучше - передать удачный приём, посоветовать специалиста, удешевить.

## Что в каталоге
- 998 удалённых серверов и 19 944 инструмента. У 95,9% инструментов издатель поставил пометки, и они настоящие, а не подставленные каталогом (поля и значения расходятся с умолчаниями MCP).
- Серверы, которые ставят у себя, не вошли: в API Glama у них нет списка инструментов.
- Требуют внимания 9,9% инструментов, хотя бы один такой есть у 31,8% серверов. Чаще всего это необратимое действие, о котором в описании ни слова (9,1%). Ещё 120 срабатываний правила «похоже на скрытое указание модели» - это эвристика, каждое надо смотреть руками. Слово «требуют внимания» выбрано сознательно: это повод присмотреться, не обвинение. Список по серверам не публикуется.
- Оценка качества Glama это отражает: среди серверов с оценкой 4-5 требуют внимания 26%, с оценкой 2-4 - 51%.

## Этап 1. Один агент-аудитор через Xonta
Сканер Xonta по названию инструмента (так сейчас работает Gate) и агент на GigaChat по описанию.
- **Сканер** почти не отличает обратимое от необратимого (8% обратимых узнано) и принимает за «только читает» четверть необратимых: в названиях вроде `save_…`, `resolve_…`, `end_call` нет слова-действия.
- **Агент** почти не путает необратимое с чтением (2 из 100), но половину необратимых считает обратимыми.
- **Вместе**, если брать более строгий ответ: 80% необратимых узнано. Вывод для Gate - одного названия мало.

Что сделала Xonta:
- **экзамен до работы** - 60%, права минимальные;
- **перепроверка по ходу** - после каждой сотни строк оркестратор выбирал строки наугад и отдавал другому агенту другого владельца. Агент называл «без замечаний» 97% инструментов. Во втором прогоне по сумме проверок не подтвердились 12 из 42 его «всё в порядке» (p = 0,0006), оркестратор приостановил задачу и сообщил владельцу;
- **фильтр правил** - агент учился на своих ошибках и за два прогона предложил больше десятка правил, несколько раз одно и то же «write значит необратимо», что противоречит данным. Ни одно не прошло проверку парами.

Одна поучительная поломка: в первом прогоне 38% ответов модели не разбирались - GigaChat клал в поле `label` название инструмента. Переименовали поле в `effect` и перечислили значения - стало 0,3%. Без отдельного счётчика неразобранных ответов эта треть тихо считалась бы «агент не уверен».

## Этап 2. Команда из трёх аудиторов: умеет ли Xonta оптимизировать
- **fast** - смотрит только название и начало описания, дешёвый;
- **careful** - читает описание и параметры, в 2,3 раза дороже;
- **dual** - как careful, плюс сканер, ответ строже из двух.

dual предложил свой приём «строже из двух», careful - «не звать модель, если название очевидно про чтение». Оркестратор мерил оба парами на задачах fast: одна и та же строка без приёма и с ним.

**На Xonta 0.21 оптимизации не было.** Оба приёма получили «без эффекта»:
- «строже из двух» сделал 10 строк лучше и 13 хуже. Но «лучше» - пойманные удаления и платежи (цена ошибки 6-10), а «хуже» - лишняя осторожность (цена 1). Вред он снижал на 16%;
- «не звать модель» ничего не испортил и экономил 11% токенов, а «так же хорошо, но дешевле» оценка не знала;
- потомка оркестратор не советовал: совет давался только за разрыв в точности.

**Что изменили в Xonta (0.22):** приёмы сравниваются по цене ошибки, когда агент её сообщает; есть исход «так же хорошо, но дешевле» - ни одной пары хуже, расход значимо ниже; совет родить потомка учитывает и вред, а не только точность.

**На Xonta 0.22 оркестратор сам передал fast приёмы двух других агентов** - в двух независимых прогонах подряд:

| на одних и тех же 240 инструментах | необратимых узнано | вред на инструмент | токенов на инструмент |
|---|---|---|---|
| fast один (team-2) | 48,8% | 1,45 | 129 |
| fast + приёмы от Xonta (team-2) | 67,5% | 1,17 | 114 |
| fast один (team-3) | 52,5% | 1,38 | 129 |
| fast + «строже из двух» (team-3) | 66,3% | 1,15 | 129, а «не звать модель» даёт 113 |

Дешёвый агент с переданными приёмами ловит опасные инструменты так же, как самый осторожный, и стоит в 2,5 раза меньше него. Цена - общая точность на 1-3 п.п. ниже: он чаще говорит «необратимо» там, где можно отменить. Для решения «вызывать ли без спроса» это правильный размен.

## Этап 3. Четвёртый аудитор на старшей модели
Проверяли, посоветует ли оркестратор потомка-специалиста, если в команде есть агент действительно сильнее в слабой категории. Для этого добавили **max** - тот же подход, что careful, на GigaChat-2-Max.

| team-4, те же 240 инструментов | верно | необратимых узнано | вред на инструмент | токенов | секунд |
|---|---|---|---|---|---|
| fast | 60,8% | 56,3% | 1,22 | 130 | 0,5 |
| careful | 64,2% | 57,5% | 1,13 | 288 | 0,5 |
| dual | 60,8% | 68,8% | 0,98 | 288 | 0,5 |
| max (старшая модель) | **65,4%** | **37,5%** | **1,44** | 255 старшей | 1,1 |
| fast + «строже из двух» от Xonta | 59,2% | **71,3%** | **0,97** | 130 | 0,5 |

Старшая модель вышла самой точной в целом и самой опасной: необратимые она узнаёт хуже всех, вред у неё самый большой, и работает она вдвое медленнее. Она чаще говорит «можно отменить». Оценка только по точности выбрала бы именно её. Оценка по вреду показывает обратное, и дешёвый агент с переданным приёмом здесь лучший по вреду.

Потомка оркестратор не посоветовал ни в одном прогоне, в том числе с полным экзаменом из 150 заданий и со старшей моделью. На экзамене все четыре агента в слабых категориях («запись», «прочее») не отличаются заметно ни по точности, ни по вреду, и совет каждый раз - пока передавать эти категории человеку. Xonta не придумывает специалиста, которого нечем обосновать. Проверить сам механизм потомков на этих данных не вышло, в тематических прогонах стенда он работает.

И ещё одна проверка защиты: в team-4 приём «не звать модель» не прошёл как «так же хорошо, но дешевле», хотя в двух прогонах до того проходил. На одном инструменте он ответил «только читает» там, где издатель пометил изменение, и цена ошибки по этой паре выросла с 1 до 4. Одна пара хуже - и «так же хорошо» уже неправда.

## Что Xonta поймала и чего без неё не было бы видно
- агент перехваливает: каждая четвёртая-пятая его «пятёрка» не подтверждается независимой проверкой;
- агент уверенно предлагает неверное правило, и не один раз;
- треть ответов модели оказалась мусором из-за одного слова в подсказке;
- самая точная модель - самая опасная для этой задачи;
- удачный приём одного агента можно передать другому и доказать, что он помогает, не на глаз, а парами на одних и тех же задачах.

## Что пришлось исправить в самой Xonta
- 0.22 - оценка приёмов по цене ошибки, исход «так же хорошо, но дешевле», совет по потомку с учётом вреда;
- сигнал массовой задачи писал цифры последней проверки вместо суммы, по которой он сработал;
- совет «оставить потомка» не говорил, за что - за точность или за меньший вред.

Открытый вопрос из комментария к прошлой статье: у вердикта рецепта не записана версия правил подсчёта, и пары по старым и новым правилам могут копиться вместе. В этих прогонах я разделял их вручную, стирая книгу оркестратора. Это следующая правка.

## Ограничения
- одна модельная семья (GigaChat), по одному-два прогона на каждую конфигурацию; общая точность гуляет между прогонами на 2-4 п.п., сравнения внутри прогона надёжнее;
- эталон - пометки издателей, а не поведение инструментов, и сами пометки бывают спорными;
- цена ошибки - условная шкала (необратимое за чтение 10, за обратимое 6, обратимое за чтение 4, лишняя осторожность 1); с другой шкалой вывод про «строже из двух» может измениться;
- серверы, которые ставят у себя, не оценены.

---

# The Glama MCP catalog through Xonta: what we did, why, and what came out

Data: the [Glama](https://glama.ai/mcp/servers) catalog, MCP Directory API, fetched on October 23, 2026. Thanks to Glama for the open directory. I didn't connect to any server or call any tool, everything comes from descriptions, schemas and publisher hints. Code - [research/glama](../../research/glama), model GigaChat-2 (plus GigaChat-2-Max in the last run). Detailed stage reports - [glama-audit-1](../glama-audit-1/README.md) and [glama-team](../glama-team/README.md).

## Why
An agent that plugs in someone else's MCP server decides in seconds whether a tool can be called without asking. A mistake one way costs an extra question to a human. The other way, deleted data, a sent email, a payment. That's what Xonta is about: how much harm an agent can be trusted with, and how it learns not to cause it.

The Glama catalog is a good test on real data. For many tools the publisher marked whether the tool reads or changes things and whether that can be undone (readOnlyHint, destructiveHint). That's a ready reference. The questions:
1. how far can you trust an agent that reads tool descriptions;
2. what does Xonta see when the agent works through it;
3. can Xonta make agents work better - pass on a good technique, advise a specialist, cut cost.

## The catalog
- 998 remote servers, 19,944 tools. 95.9% of tools have publisher hints, and they're real, not filled in by the catalog (fields and values differ from the MCP defaults).
- Self-hosted servers aren't included: the Glama API has no tool list for them.
- 9.9% of tools need attention; 31.8% of servers have at least one. Most often it's an irreversible action with no word about it in the description (9.1%). Another 120 hits of the "looks like a hidden instruction to the model" rule are a heuristic, each needs a manual look. "Need attention" is chosen on purpose: a reason to look closer, not an accusation. No per-server list is published.
- The Glama quality score reflects it: 26% of servers scored 4-5 need attention, 51% of those scored 2-4.

## Stage 1. One auditor agent through Xonta
The Xonta scanner by tool name (how Gate works today) and a GigaChat agent by description.
- **The scanner** can barely tell reversible from irreversible (8% of reversible found) and takes a quarter of irreversible tools as read-only: names like `save_…`, `resolve_…`, `end_call` carry no action word.
- **The agent** almost never mistakes irreversible for a read (2 of 100), but calls half of them reversible.
- **Together**, taking the stricter answer: 80% of irreversible tools found. For Gate: the name alone isn't enough.

What Xonta did:
- **exam before work** - 60%, minimal rights;
- **re-check during work** - after every hundred rows the orchestrator picked rows at random and gave them to an agent of another owner. The agent called 97% of tools "no concerns". In the second run 12 of 42 of its "all fine" weren't confirmed over all checks (p = 0.0006); the orchestrator paused the job and told the owner;
- **rule filter** - the agent learned from its mistakes and proposed more than ten rules over two runs, several of them the same "write means irreversible", which the data contradicts. None passed the paired check.

One instructive failure: in the first run 38% of model answers couldn't be parsed - GigaChat put the tool name into the `label` field. Renamed the field to `effect` and listed the values - 0.3%. Without a separate counter for unusable answers, that third would silently have counted as "the agent is unsure".

## Stage 2. A team of three auditors: can Xonta optimise
- **fast** - only the name and the start of the description, cheap;
- **careful** - description and parameters, 2.3 times the tokens;
- **dual** - careful plus the scanner, the stricter of two answers.

dual proposed "stricter of two", careful proposed "don't call the model if the name is obviously a read". The orchestrator measured both in pairs on fast's tasks: the same row with and without the technique.

**On Xonta 0.21 there was no optimisation.** Both got "no effect":
- "stricter of two" made 10 rows better and 13 worse. But "better" means caught deletions and payments (mistake cost 6-10), "worse" means extra caution (cost 1). It cut harm by 16%;
- "don't call the model" broke nothing and saved 11% of tokens, and "same, but cheaper" wasn't an outcome;
- no child was advised: the advice only fired on an accuracy gap.

**What changed in Xonta (0.22):** techniques are compared by the cost of mistakes when the agent reports it; a "same, but cheaper" outcome - no pair worse, significantly lower cost; the child advice counts harm, not only accuracy.

**On Xonta 0.22 the orchestrator passed both techniques to fast by itself**, in two independent runs in a row:

| on the same 240 tools | irreversible found | harm per tool | tokens per tool |
|---|---|---|---|
| fast alone (team-2) | 48.8% | 1.45 | 129 |
| fast + techniques from Xonta (team-2) | 67.5% | 1.17 | 114 |
| fast alone (team-3) | 52.5% | 1.38 | 129 |
| fast + "stricter of two" (team-3) | 66.3% | 1.15 | 129, and "don't call the model" gives 113 |

The cheap agent with the passed-on techniques catches dangerous tools as well as the most careful one, at 2.5 times less cost. The price is 1-3 points of overall accuracy: it says "irreversible" more often where the change can be undone. For "call it without asking or not", that's the right trade.

## Stage 3. A fourth auditor on the senior model
Would the orchestrator advise a specialist child if the team had an agent that's really stronger in a weak category? Added **max** - the careful approach on GigaChat-2-Max.

| team-4, same 240 tools | right | irreversible found | harm per tool | tokens | seconds |
|---|---|---|---|---|---|
| fast | 60.8% | 56.3% | 1.22 | 130 | 0.5 |
| careful | 64.2% | 57.5% | 1.13 | 288 | 0.5 |
| dual | 60.8% | 68.8% | 0.98 | 288 | 0.5 |
| max (senior model) | **65.4%** | **37.5%** | **1.44** | 255 senior | 1.1 |
| fast + "stricter of two" from Xonta | 59.2% | **71.3%** | **0.97** | 130 | 0.5 |

The senior model came out the most accurate overall and the most dangerous: it finds irreversible tools worst of all, does the most harm, and is twice as slow. It says "can be undone" more often. An accuracy-only score would pick exactly this model. A harm score shows the opposite, and the cheap agent with the passed-on technique is the best by harm.

The orchestrator didn't advise a child in any run, including the full 150-task exam and the senior model. On the exam all four agents are close in the weak categories ("write", "other") in both accuracy and harm, and each time the advice is to hand those categories to a human for now. Xonta doesn't invent a specialist it can't justify. The child mechanism itself couldn't be tested on this data; in the stand's theme runs it works.

One more check of the safeguards: in team-4 "don't call the model" didn't pass as "same, but cheaper", though it had in the two runs before. On one tool it answered "read only" where the publisher marked a change, and the mistake cost for that pair went from 1 to 4. One pair worse, and "same" is no longer true.

## What Xonta caught that wouldn't be visible without it
- the agent overrates: every fourth or fifth "all fine" fails an independent check;
- the agent confidently proposes a wrong rule, more than once;
- a third of the model's answers were junk because of one word in the prompt;
- the most accurate model is the most dangerous one for this task;
- one agent's good technique can be passed to another and shown to help, not by eye, but in pairs on the same tasks.

## What had to be fixed in Xonta itself
- 0.22 - techniques judged by the cost of mistakes, a "same, but cheaper" outcome, child advice that counts harm;
- the long-job signal showed the last check's numbers instead of the total that triggered it;
- the "keep the child" advice didn't say why - accuracy or less harm.

Open question from a comment on the previous article: a recipe verdict doesn't record the scoring version, and pairs scored under old and new rules can pool together. In these runs I kept them apart by hand, wiping the orchestrator's book. That's the next fix.

## Limits
- one model family (GigaChat), one or two runs per configuration; overall accuracy moves 2-4 points between runs, comparisons within a run are more reliable;
- the reference is publisher hints, not tool behaviour, and the hints themselves are sometimes debatable;
- the mistake cost is a chosen scale (irreversible as read 10, as reversible 6, reversible as read 4, extra caution 1); with another scale the verdict on "stricter of two" may change;
- self-hosted servers are not assessed.
