# Команда аудиторов каталога Glama: что оркестратор передал и что это дало

[English below](#a-team-of-glama-catalog-auditors-what-the-orchestrator-passed-on-and-what-it-gave)

Данные: каталог [Glama](https://glama.ai/mcp/servers) (MCP Directory API), выгрузка 23 октября 2026, удалённые серверы. Спасибо Glama за открытый каталог. К серверам ничего не подключалось, только описания и пометки издателей. Код - [research/glama/team.mjs](../../research/glama/team.mjs), модель GigaChat-2.

Три аудитора решают, что делает инструмент MCP: только читает, меняет обратимо или необратимо. Эталон - пометки издателя.
- **fast** - смотрит только название и начало описания, дешёвый;
- **careful** - читает описание и параметры, в 2,3 раза дороже;
- **dual** - как careful, плюс сканер Xonta по названию, ответ строже из двух.

Два прогона на одном и том же экзамене (150 заданий) и одних и тех же 240 инструментах вне экзамена, поровну по трём классам: team-1 на Xonta 0.21, team-2 на 0.22.

## team-1 (0.21): оптимизировать было что, но Xonta ничего не взяла
| | fast | careful | dual |
|---|---|---|---|
| верно | 63,8% | 69,2% | 67,1% |
| необратимых узнано | 55% | 55% | 72,5% |
| вред на инструмент | 1,30 | 1,20 | 0,93 |
| токенов на инструмент | 129 | 300 | 300 |

dual предложил свой приём «строже из двух», careful - «не звать модель на очевидном чтении». Оркестратор мерил оба парами на задачах fast:
- «строже из двух» - **без эффекта**: 10 строк лучше, 13 хуже. Но «лучше» - это пойманные необратимые (цена ошибки 6-10), а «хуже» - лишняя осторожность на читающих (цена 1). На fast приём снижал вред на 16%;
- «не звать модель» - **без эффекта**: 0 лучше, 0 хуже, а токенов на 11% меньше. «Так же хорошо, но дешевле» оценка не умела;
- потомка не советовал: совет давался только за разрыв в точности 15 п.п., а точность у всех почти одна.

Команда «fast + потомок + доказанные приёмы» вышла ровно fast.

## Что изменили в Xonta (0.22, с согласия владельца)
- если агент сообщает цену ошибки по каждой паре, приём оценивается по вреду, а не по «верно / неверно»;
- новый исход «так же хорошо, но дешевле»: ни одной пары хуже, расход значимо ниже;
- совет родить потомка - и когда другой агент в категории не точнее, но вреда на 30% меньше; в совете сказано, чей подход перенять.

## team-2 (0.22): оркестратор сам передал fast приёмы двух других агентов
- «строже из двух» (от dual) - **доказан по вреду**: на 240 парах вреда меньше на 0,29 на инструмент, p = 0,0015;
- «не звать модель на очевидном чтении» (от careful) - **доказан как «так же хорошо, но дешевле»**: 39 пар, ни одной хуже, на 89 токенов меньше на задачу.

| на тех же 240 инструментах | верно | необратимых узнано | вред на инструмент | токенов на инструмент |
|---|---|---|---|---|
| fast один | 60,8% | 48,8% | 1,45 | 129 |
| careful один | 64,6% | 50% | 1,37 | 290 |
| dual один | 60% | 66,3% | 1,15 | 290 |
| **fast + оба приёма от Xonta** | 58,3% | **67,5%** | **1,17** | **114** |

Что это значит простыми словами: дешёвый агент после приёмов, которые ему передал оркестратор, ловит опасные инструменты так же, как самый осторожный (67,5% против 66,3%), с тем же вредом, и стоит в 2,5 раза дешевле него - и на 12% дешевле, чем был сам. Цена - общая точность на 2,5 п.п. ниже: он чаще говорит «необратимо» там, где на деле можно отменить (12,5% читающих инструментов помечены как опасные). Для агента, который решает, вызывать ли инструмент без спроса, это правильный размен: лишний вопрос человеку стоит дешевле удалённых данных.

**Потомка оркестратор не посоветовал и в team-2.** Совет строится по экзамену, а на экзамене 60 заданий на шесть категорий - в «записи» около 17. На таком числе вред у fast и dual по категории почти не различается, до порога 30% не доходит. В работе на 240 строках разница видна, но совет её не берёт. Совет был: «запись» и «прочее» пока передавать человеку. Следующий шаг - экзамен на все 150 заданий.

**Повтор (team-3, тот же код, экзамен на все 150 заданий).** Оба приёма доказаны снова: «строже из двух» по вреду (240 пар, p = 0,003), «не звать модель» как «так же хорошо, но дешевле» (43 пары, ни одной хуже, на 88 токенов меньше). На fast: необратимых узнано 66,3% вместо 52,5%, вред 1,15 вместо 1,38 (−17%), токенов 113 вместо 129. Потомка оркестратор не посоветовал и на полном экзамене: все три аудитора на одной модели и сдали экзамен почти одинаково (66%, 66%, 65,3%), в «записи» никто не выигрывает ни по точности, ни по вреду. Xonta не придумывает специалиста, когда его нечем обосновать, и советует пока передавать «запись» человеку.

## Ограничения
- одна модель, по одному прогону на каждой версии Xonta; общая точность от прогона к прогону гуляет на 2-4 п.п., поэтому сравнение внутри прогона (одни и те же строки) надёжнее, чем между прогонами;
- эталон - пометки издателей, а не поведение инструментов;
- цена ошибки - условная шкала (10 / 6 / 4 / 1), с другой шкалой выводы по приёму «строже из двух» могут измениться.

---

# A team of Glama catalog auditors: what the orchestrator passed on and what it gave

Data: the [Glama](https://glama.ai/mcp/servers) catalog (MCP Directory API), fetched on October 23, 2026, remote servers. Thanks to Glama for the open directory. Nothing connected to servers, only descriptions and publisher hints. Code - [research/glama/team.mjs](../../research/glama/team.mjs), model GigaChat-2.

Three auditors decide what an MCP tool does: read only, reversible or irreversible change. The reference is the publisher's hints.
- **fast** - only the name and the start of the description, cheap;
- **careful** - description and parameters, 2.3 times the tokens;
- **dual** - careful plus the Xonta name scanner, the stricter of two answers.

Two runs on the same exam (150 tasks) and the same 240 tools outside the exam, even across three classes: team-1 on Xonta 0.21, team-2 on 0.22.

## team-1 (0.21): there was something to optimise, Xonta took none of it
| | fast | careful | dual |
|---|---|---|---|
| right | 63.8% | 69.2% | 67.1% |
| irreversible found | 55% | 55% | 72.5% |
| harm per tool | 1.30 | 1.20 | 0.93 |
| tokens per tool | 129 | 300 | 300 |

- "stricter of two" from dual - **no effect**: 10 rows better, 13 worse. But "better" means caught irreversible tools (mistake cost 6-10) and "worse" means extra caution on read-only ones (cost 1). On fast it cut harm by 16%;
- "don't call the model on obvious reads" from careful - **no effect**: 0 better, 0 worse, 11% fewer tokens. "Same, but cheaper" wasn't a possible outcome;
- no child advised: it took a 15-point accuracy gap, and accuracy was about the same for everyone.

## What changed in Xonta (0.22, approved by the owner)
- when the agent reports the cost of a mistake for each pair, a technique is judged by harm, not right/wrong;
- a new outcome "same, but cheaper": no pair worse, significantly lower cost;
- the advice to spawn a child also fires when another agent isn't more accurate in a category but does 30% less harm, and it names whose approach to copy.

## team-2 (0.22): the orchestrator passed both techniques to fast
- "stricter of two" (from dual) - **proven by harm**: 0.29 less harm per tool over 240 pairs, p = 0.0015;
- "don't call the model on obvious reads" (from careful) - **proven as "same, but cheaper"**: 39 pairs, none worse, 89 fewer tokens per task.

| on the same 240 tools | right | irreversible found | harm per tool | tokens per tool |
|---|---|---|---|---|
| fast alone | 60.8% | 48.8% | 1.45 | 129 |
| careful alone | 64.6% | 50% | 1.37 | 290 |
| dual alone | 60% | 66.3% | 1.15 | 290 |
| **fast + both techniques from Xonta** | 58.3% | **67.5%** | **1.17** | **114** |

In plain words: with the techniques the orchestrator passed on, the cheap agent catches dangerous tools as well as the most careful one (67.5% vs 66.3%), with the same harm, at 2.5 times less cost - and 12% cheaper than it was itself. The price is 2.5 points of overall accuracy: it says "irreversible" more often where the change can be undone (12.5% of read-only tools flagged). For an agent deciding whether to call a tool without asking, that's the right trade: an extra question to a human costs less than deleted data.

**No child advised in team-2 either.** The advice is built from the exam, and 60 exam tasks over six categories leave about 17 for "write". With that few, fast and dual barely differ in harm on the category, short of the 30% threshold. On 240 work rows the gap is visible, but the advice doesn't use it. It said to hand "write" and "other" to a human for now. Next step - an exam on all 150 tasks.

**Replication (team-3, same code, exam on all 150 tasks).** Both techniques proven again: "stricter of two" by harm (240 pairs, p = 0.003), "don't call the model" as "same, but cheaper" (43 pairs, none worse, 88 fewer tokens). On fast: irreversible found 66.3% instead of 52.5%, harm 1.15 instead of 1.38 (−17%), tokens 113 instead of 129. No child advised even on the full exam: all three auditors use one model and scored almost the same (66%, 66%, 65.3%), nobody wins on "write" in accuracy or harm. Xonta doesn't invent a specialist it can't justify, and advises handing "write" to a human for now.

## Limits
- one model, one run per Xonta version; overall accuracy moves 2-4 points between runs, so comparisons within a run (same rows) are more reliable than between runs;
- the reference is publisher hints, not tool behaviour;
- the mistake costs are a chosen scale (10 / 6 / 4 / 1); with another scale the verdict on "stricter of two" may change.
