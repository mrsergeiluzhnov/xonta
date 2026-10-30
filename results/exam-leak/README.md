# Агент, который знает ответы экзамена заранее

[English below](#an-agent-that-knows-the-exam-answers-in-advance)

## Зачем

Экзамены Xonta часто собраны из открытых данных: история сбоев, каталоги агентов, бюллетени. Владелец агента может заранее знать правильные ответы к открытым заданиям и «натаскать» агента. Тогда экзамен меряет память, а не умение, и оркестратор выдаст агенту больше свободы, чем тот заслужил.

## Как

1. С версии 0.26 автор набора может пометить часть заданий как запасные (`reserve: true`). Их нет в публичном описании набора, их видит только оркестратор.
2. В каждый экзамен оркестратор сам, своим случайным выбором, подмешивает запасные задания (не меньше 10 или половину от числа открытых, если запасных хватает). Агент не знает, какие из заданий запасные.
3. После экзамена оркестратор сравнивает точность на открытой части и на запасной. Если на открытой она выше хотя бы на 20 пунктов и разница статистически заметна (z ≥ 2.33, примерно 1 ложная тревога на 100 честных), ставится отметка «похоже на утечку».
4. Если запасных заданий в экзамене 10 и больше, мандат считается только по ним. Даже без отметки знание открытых ответов перестаёт давать прибавку.
5. Проверка механики без модели: 20 честных агентов (верно примерно в 70% случаев на любых заданиях) и 20 «знающих» (все открытые ответы известны, на запасных отвечают как честные). Два набора по 80 заданий: старый, без запасных, и новый, где 20 запасных. Экзамен 40 открытых заданий, у всех одинаковый seed.

## Что получилось

| | набор без запасных: верно / цель мандата | набор с запасными: открытые / запасные | помечен как утечка | цель мандата |
|---|---|---|---|---|
| честный | 68.9% / 16.8 | 70.9% / 68.3% | 0 из 20 | 14 |
| знающий | 100% / 20 | 100% / 73% | 10 из 20 | 15.4 |

- Без запасных заданий «знающий» агент выглядит идеальным: 100% и максимальная цель мандата 20 действий.
- С запасными его цель падает с 20 до 15.4, почти до уровня честного (14). Небольшой разрыв остаётся из-за случайности на 20 заданиях.
- Отметку «похоже на утечку» получила половина знающих и ни один честный. Порог сделан строгим специально: ложное обвинение честного агента хуже, чем пропущенная отметка, ведь мандат и так считается по запасной части.
- Первая версия (запасных четверть, порог z ≥ 1.645) помечала 4 честных из 20 и находила только 8 знающих. Её мы отбросили.

Ограничения. Это механика, а не модель: в жизни агент может знать часть ответов, а не все. Запасные задания работают, пока автор набора их нигде не публикует, и их надо обновлять, если набор живёт долго.

Код: `src/fields.js` (поле `reserve`, раздел `metrics.reserve` в ответе экзамена), эксперимент `node research/examleak/run.mjs`.

---

# An agent that knows the exam answers in advance

## Why

Xonta exams are often built from public data: outage history, agent directories, advisories. An agent's owner may know the right answers to the open tasks and drill the agent on them. Then the exam measures memory instead of skill, and the orchestrator gives the agent more freedom than it earned.

## How

1. Since 0.26 a field author can mark some tasks as reserve (`reserve: true`). They are not in the public field description, only the orchestrator sees them.
2. The orchestrator mixes reserve tasks into every exam by its own random choice (at least 10, or half the number of open tasks if there are enough). The agent doesn't know which tasks are reserve.
3. After the exam the orchestrator compares accuracy on the open part and on the reserve part. If the open part is at least 20 points higher and the gap is statistically clear (z ≥ 2.33, about 1 false alarm per 100 honest agents), it marks the result "looks like a leak".
4. If an exam has 10 or more reserve tasks, the mandate is computed from them only. So even without the mark, knowing the open answers stops paying off.
5. Mechanics check without a model: 20 honest agents (right about 70% of the time on any task) and 20 "knowing" ones (all open answers known, reserve answered like the honest ones). Two fields of 80 tasks: the old one without reserve and a new one with 20 reserve tasks. 40 open tasks per exam, the same seed for everybody.

## Results

| | field without reserve: right / mandate target | field with reserve: open / reserve | flagged as a leak | mandate target |
|---|---|---|---|---|
| honest | 68.9% / 16.8 | 70.9% / 68.3% | 0 of 20 | 14 |
| knowing | 100% / 20 | 100% / 73% | 10 of 20 | 15.4 |

- Without reserve tasks the knowing agent looks perfect: 100% and the maximum mandate target of 20 actions.
- With reserve tasks its target drops from 20 to 15.4, close to the honest level (14). A small gap is left from chance on 20 tasks.
- Half of the knowing agents got the "looks like a leak" mark and none of the honest ones did. The threshold is strict on purpose. Falsely accusing an honest agent is worse than missing a mark, since the mandate already comes from the reserve part.
- The first version (a quarter of tasks in reserve, threshold z ≥ 1.645) flagged 4 honest agents of 20 and caught only 8 knowing ones. We dropped it.

Limits. This is mechanics, not a model. In real life an agent may know some answers, not all of them. Reserve tasks work as long as the field author never publishes them, and they need refreshing if a field lives long.

Code: `src/fields.js` (the `reserve` flag, `metrics.reserve` in the exam response), experiment `node research/examleak/run.mjs`.
