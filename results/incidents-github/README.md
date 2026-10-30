# Модель не видит, что сбой серьёзный, а оркестратор находит это в исходах: сбои GitHub

[English below](#the-model-misses-major-outages-the-orchestrator-finds-the-signal-in-outcomes-github-incidents)

Данные: открытая история страницы статуса GitHub, 391 инцидент с мая 2025 по октябрь 2026, из них 101 крупный (major или critical); плановые работы исключены. Для проверки переноса — история DigitalOcean (263 инцидента, крупных 21). Ретроспектива: мы не обнаруживаем сбои раньше сервисов, а проверяем решения на истории.

Задача дежурного агента: по тому, что известно в первые 30 минут (название, первое сообщение, следующие сообщения, затронутые компоненты), сказать, крупный это сбой или нет. Эталон — итоговая серьёзность, которую GitHub сам выставил инциденту. Вред: пропустить крупный сбой — 6, лишняя тревога или «не знаю» — 1. Модель — GigaChat-2.

Каждый прогон делит инциденты GitHub поровну по серьёзности на экзамен, половину A (здесь учатся и меряют правила) и отложенную половину B (на ней правила не выбирались). Два прогона на разных разбиениях: inc-3 и inc-4.

## Что делает модель
По первым сообщениям модель почти всегда отвечает «мелкий»: пропускает 96–98% крупных сбоев. Тексты GitHub и правда звучат спокойно: «We are investigating reports of degraded performance / degraded availability». Агент, который видит ещё и сообщения за 30 минут, пропускает 89–91%.

Агент выводил правила из 30 своих ошибок. Оркестратор измерил их парами (тот же инцидент с правилом и без): одно в каждом прогоне чаще вредило и было отозвано, остальные почти ни на что не влияли.

## Что нашла Xonta
Xonta сама прошла по журналу исходов половины A и нашла слова, которые чаще встречаются у крупных сбоев (у крупных / у мелких):
- прогон inc-3: «availability» 35% / 9%, «will» 17% / 4%;
- прогон inc-4: «availability» 43% / 13%, «continuing» 39% / 9%, «investigate» 39% / 11%, «mitigation» 20% / 4%.

В обоих прогонах первым признаком оказалось «availability»: GitHub пишет «degraded availability», когда сервис частично недоступен, и «degraded performance», когда он просто медленнее. «Continuing to investigate» за первые 30 минут значит, что быстро починить не вышло. Правило «есть эти слова — крупный сбой» оркестратор доказал парами на половине A (inc-3: лучше в 19 парах, хуже в 6; inc-4: лучше в 31, хуже в 14) и передал агенту.

## Итог на отложенной половине B (90 инцидентов, поровну по серьёзности)

| конфигурация | верно | пропустил крупный | лишняя тревога | вред на инцидент |
|---|---|---|---|---|
| агент один, inc-3 | 51,1% | 97,8% | 0% | 2,93 |
| агент один, inc-4 | 52,2% | 95,6% | 0% | 2,87 |
| агент + слова Xonta, inc-3 | 62,2% | 46,7% | 28,9% | 1,54 |
| агент + слова Xonta, inc-4 | 67,8% | 28,9% | 35,6% | 1,04 |
| агент + все правила, доказанные Xonta, inc-3 | 65,6% | 22,2% | 46,7% | 0,90 |
| агент + все правила, доказанные Xonta, inc-4 | 63,3% | 22,2% | 51,1% | 0,92 |

«Все правила, доказанные Xonta» — слова Xonta плюс более строгий из двух ответов: модели и сканера по словам отказа (outage, unavailable, unable to…). Оба прогона дают одну картину: пропуски крупных сбоев падают с 96–98% до 22%, вред — в 3 с лишним раза.

## Цена: ложные тревоги
Почти половина мелких сбоев теперь вызывает тревогу. На выборке поровну это выгодно. У GitHub крупных сбоев около четверти, и при таком соотношении по одному проценту верных ответ «всегда мелкий» лучше (около 75% против 56–60% с правилами). Правила выигрывают потому, что пропущенный крупный сбой стоит дороже лишней тревоги. При нашей шкале 6 к 1 и реальном соотношении вред с правилами примерно вдвое ниже (около 0,7 против 1,5 на инцидент). Если для вас пропуск стоит столько же, сколько лишняя тревога, эти правила вам не нужны.

## Перенос на DigitalOcean
Правила, прошедшие проверку на GitHub, применили к 22 инцидентам DigitalOcean (у DigitalOcean всего 21 крупный сбой, половины не делили). Пропуски крупных сбоев: 73% → 9% (inc-3) и 64% → 18% (inc-4), ложные тревоги выросли до 73% и 46%. Оркестратор на этих 22 инцидентах не признал ни одно правило по отдельности: в inc-4 слова Xonta получили «без эффекта», сканер был отозван. Это намёк на перенос, а не доказательство.

## Что это показывает
1. Агент не видит закономерность в собственных ошибках, а оркестратор, у которого есть журнал исходов, видит: «degraded availability» у GitHub значит больше, чем кажется модели.
2. Найденное держится на инцидентах, которые его не видели, и повторяется на другом разбиении.
3. Ценность правил — в цене пропуска, а не в проценте верных. Это надо решать владельцу агента, а не модели.
4. Язык сбоев у каждого сервиса свой. Перенос между сервисами пока не доказан.

## Ограничения
Одна модель, два прогона на одних и тех же данных GitHub с разными разбиениями, выборки поровну по серьёзности, эталон — серьёзность, которую сервис выставил сам (её могут менять в ходе инцидента). Первые два прогона (inc-1 и inc-2, учёба на DigitalOcean) ничего не показали: у DigitalOcean слишком мало крупных сбоев, а по одному первому сообщению серьёзность не видна совсем.

Код: [research/incidents](../../research/incidents). Сборщик истории — `fetch.mjs`, эксперимент — `team.mjs`. Токенов на прогон около 80 тысяч.

---

# The model misses major outages, the orchestrator finds the signal in outcomes: GitHub incidents

Data: the public GitHub status page history, 391 incidents from May 2025 to October 2026, 101 of them major or critical; scheduled maintenance excluded. For the transfer check, DigitalOcean's history (263 incidents, 21 major). This is a retrospective study: we don't detect outages before the services do, we check decisions on history.

The on-call agent's task: from what is known in the first 30 minutes (title, first update, following updates, affected components), say whether it's a major outage. The reference is the final impact GitHub itself set. Harm: missing a major outage 6, a false alarm or "unsure" 1. Model: GigaChat-2.

Each run splits GitHub incidents, balanced by severity, into an exam, half A (rules are learned and measured here) and a held-out half B (never used to pick rules). Two runs on different splits: inc-3 and inc-4.

## What the model does
From the early updates the model nearly always says "minor" and misses 96-98% of major outages. GitHub's texts do sound calm: "We are investigating reports of degraded performance / degraded availability". The agent that also reads the first 30 minutes of updates misses 89-91%.

The agent wrote rules from 30 of its own mistakes. The orchestrator measured them in pairs (the same incident with and without the rule): in each run one of them did more harm and was revoked, the rest barely changed anything.

## What Xonta found
Xonta went through the half A outcome log itself and found words that show up more in major outages (major / minor):
- run inc-3: "availability" 35% / 9%, "will" 17% / 4%;
- run inc-4: "availability" 43% / 13%, "continuing" 39% / 9%, "investigate" 39% / 11%, "mitigation" 20% / 4%.

In both runs the top signal was "availability": GitHub writes "degraded availability" when a service is partly down and "degraded performance" when it's just slower. "Continuing to investigate" within 30 minutes means a quick fix didn't work. The orchestrator proved the rule "these words mean major" in pairs on half A (inc-3: better in 19 pairs, worse in 6; inc-4: better in 31, worse in 14) and passed it to the agent.

## Result on held-out half B (90 incidents, balanced)

| configuration | right | missed major | false alarm | harm per incident |
|---|---|---|---|---|
| agent alone, inc-3 | 51.1% | 97.8% | 0% | 2.93 |
| agent alone, inc-4 | 52.2% | 95.6% | 0% | 2.87 |
| agent + Xonta's words, inc-3 | 62.2% | 46.7% | 28.9% | 1.54 |
| agent + Xonta's words, inc-4 | 67.8% | 28.9% | 35.6% | 1.04 |
| agent + all rules Xonta proved, inc-3 | 65.6% | 22.2% | 46.7% | 0.90 |
| agent + all rules Xonta proved, inc-4 | 63.3% | 22.2% | 51.1% | 0.92 |

"All rules Xonta proved" is Xonta's words plus the stricter of the model's answer and an outage-word scanner (outage, unavailable, unable to...). Both runs tell the same story: missed major outages fall from 96-98% to 22%, harm by more than 3 times.

## The price: false alarms
About half of minor incidents now raise an alarm. On a balanced sample that pays off. GitHub has roughly one major outage in four, and at that ratio "always minor" wins on plain accuracy (about 75% against 56-60% with the rules). The rules win because a missed major outage costs more than a false alarm. On our 6-to-1 scale and the real ratio, harm with the rules is about half (around 0.7 against 1.5 per incident). If a miss costs you the same as a false alarm, you don't need these rules.

## Transfer to DigitalOcean
The rules that passed on GitHub were applied to 22 DigitalOcean incidents (DigitalOcean has only 21 major outages, so no halves). Missed major outages: 73% → 9% (inc-3) and 64% → 18% (inc-4), false alarms rose to 73% and 46%. On these 22 incidents the orchestrator didn't accept any single rule: in inc-4 Xonta's words got "no effect" and the scanner was revoked. A hint of transfer, not proof.

## What this shows
1. The agent doesn't see the pattern in its own mistakes; the orchestrator, which keeps the outcome log, does: "degraded availability" at GitHub means more than the model thinks.
2. What was found holds on incidents that never saw it and repeats on a different split.
3. The value of the rules lies in the cost of a miss, not in the percentage right. That is the agent owner's call, not the model's.
4. Every service has its own way of writing about outages. Transfer between services is not proven yet.

## Limits
One model, two runs on the same GitHub data with different splits, samples balanced by severity, the reference is the impact the service set itself (it can change during an incident). The first two runs (inc-1 and inc-2, learning on DigitalOcean) showed nothing: DigitalOcean has too few major outages, and the first update alone doesn't show severity at all.

Code: [research/incidents](../../research/incidents). History collector `fetch.mjs`, experiment `team.mjs`. About 80 thousand tokens per run.
