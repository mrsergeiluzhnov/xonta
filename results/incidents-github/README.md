# Модель не видит, что сбой серьёзный, а оркестратор находит это в исходах: сбои GitHub

[English below](#the-model-misses-major-outages-the-orchestrator-finds-the-signal-in-outcomes-github-incidents)

Данные: открытая история страницы статуса GitHub, 391 инцидент с мая 2025 по октябрь 2026, из них 101 крупный (major или critical); плановые работы исключены. Для проверки переноса — история DigitalOcean (263 инцидента, крупных 21). Ретроспектива: мы не обнаруживаем сбои раньше сервисов, а проверяем решения на истории.

Задача дежурного агента: по тому, что известно в первые 30 минут (название, первое сообщение, следующие сообщения, затронутые компоненты), сказать, крупный это сбой или нет. Эталон — итоговая серьёзность, которую GitHub сам выставил инциденту. Вред: пропустить крупный сбой — 6, лишняя тревога или «не знаю» — 1. Модель — GigaChat-2.

Каждый прогон делит инциденты GitHub поровну по серьёзности на экзамен, половину A (здесь учатся и меряют правила) и отложенную половину B (на ней правила не выбирались). Два прогона на разных разбиениях: inc-3 и inc-4.

## Поправка от 30 октября 2026

В таблицах ниже не хватало строки для сравнения с простейшим правилом без модели: «всегда крупный». На выборке поровну и при шкале 6 к 1 оно ошибается только на мелких сбоях, по 1 за каждый, и даёт вред 0,5 на инцидент. Это лучше всех конфигураций в отчёте, в том числе лучшей (0,90). При реальной доле крупных у GitHub (около четверти) «всегда крупный» даёт около 0,75, а правила Xonta около 0,7, то есть почти столько же.

Что остаётся верным: модель пропускает почти все крупные сбои, Xonta сама нашла признак «availability», которого модель не видит, и правила Xonta снижают вред агента в 3 раза. Что неверно: считать это знанием, которое лучше простой тревоги по любому поводу. Шкала 6 к 1 сама делает тревогу выгодной, если шанс крупного сбоя выше 1 из 7.

Мы заметили это на следующем эксперименте, сети из двух оркестраторов, где «доказанные» правила GitHub подняли тревогу на 98% мелких сбоев. В версии 0.26 оркестратор больше не признаёт приём доказанным, если тот не лучше простейшего правила (агент сообщает его вред в каждой паре). В отчётах появилась строка «всегда serious», шкалу и долю крупных теперь можно задать как в жизни (`INC_FALSE_ALARM`, `INC_NATURAL`). Перезапуск с ценой тревоги 2 и реальной долей крупных уже сделан ([сеть из двух оркестраторов](../network-orchestrators/README.md)). На GitHub слова Xonta («availability», «starting») снова доказаны и теперь бьют константу: вред 0,91 против 1,29 у агента и 1,54 у «всегда крупный».

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

## Перенос на DigitalOcean (мало данных)
Правила, прошедшие проверку на GitHub, применили к 22 инцидентам DigitalOcean (у DigitalOcean всего 21 крупный сбой, половины не делили). Пропуски крупных сбоев: 73% → 9% (inc-3) и 64% → 18% (inc-4), ложные тревоги выросли до 73% и 46%. Оркестратор на этих 22 инцидентах не признал ни одно правило по отдельности: в inc-4 слова Xonta получили «без эффекта», сканер был отозван. Это намёк на перенос, а не доказательство.

## Перенос на Discord и npm
Ещё два прогона: учёба на GitHub (так же, как выше), перенос на Discord (408 инцидентов, крупных 120) и npm (310, крупных 70). У них хватает крупных сбоев, поэтому правила меряли заново на половине A нового сервиса, а итог — на отложенной половине B.

На GitHub «availability» нашлось в третий и четвёртый раз (43% / 7% и 48% / 13%). А на новых сервисах это слово почти не встречается: правило сработало в 3 парах из 106 на Discord и в 1 из 56 на npm, оркестратор поставил ему «без эффекта». Зато общий сканер по словам отказа (outage, unavailable, unable to…) оркестратор подтвердил на обоих сервисах заново: на Discord лучше в 13 парах, хуже в 8; на npm лучше в 9, хуже в 5.

Отложенная половина B:

| | Discord (104) | npm (54) |
|---|---|---|
| агент один: пропустил крупный / вред | 75% / 2,31 | 63% / 1,94 |
| + всё, что прошло проверку на GitHub | 52% / 1,70 | 26% / 0,91 |
| + только то, что Xonta подтвердила на новом сервисе | 50% / 1,65 | 37% / 1,20 |

Вред снизился на 28% на Discord и на 38–53% на npm, ложных тревог стало больше (до 31% и 26%). На npm набор «всё с GitHub» оказался чуть лучше, чем «только подтверждённое»: туда вошло ещё одно правило, которое агент GitHub вывел из своих ошибок. Но разница — три крупных сбоя из 27, это в пределах случайности.

## Что это показывает
1. Агент не видит закономерность в собственных ошибках, а оркестратор, у которого есть журнал исходов, видит: «degraded availability» у GitHub значит больше, чем кажется модели.
2. Найденное держится на инцидентах, которые его не видели, и повторяется на другом разбиении.
3. Ценность правил — в цене пропуска, а не в проценте верных. Это надо решать владельцу агента, а не модели.
4. Язык сбоев у каждого сервиса свой. Местное слово GitHub не переносится, общие признаки отказа переносятся. Оркестратор различает это сам: местное правило на новом сервисе не подтверждает, общее подтверждает заново.

## Ограничения
Одна модель, четыре прогона учёбы на одних и тех же данных GitHub с разными разбиениями, по одному прогону переноса на каждый сервис, выборки поровну по серьёзности, эталон — серьёзность, которую сервис выставил сам (её могут менять в ходе инцидента). Первые два прогона (inc-1 и inc-2, учёба на DigitalOcean) ничего не показали: у DigitalOcean слишком мало крупных сбоев, а по одному первому сообщению серьёзность не видна совсем.

Код: [research/incidents](../../research/incidents). Сборщик истории — `fetch.mjs`, эксперимент — `team.mjs`. Токенов на прогон около 80 тысяч.

---

# The model misses major outages, the orchestrator finds the signal in outcomes: GitHub incidents

Data: the public GitHub status page history, 391 incidents from May 2025 to October 2026, 101 of them major or critical; scheduled maintenance excluded. For the transfer check, DigitalOcean's history (263 incidents, 21 major). This is a retrospective study: we don't detect outages before the services do, we check decisions on history.

The on-call agent's task: from what is known in the first 30 minutes (title, first update, following updates, affected components), say whether it's a major outage. The reference is the final impact GitHub itself set. Harm: missing a major outage 6, a false alarm or "unsure" 1. Model: GigaChat-2.

Each run splits GitHub incidents, balanced by severity, into an exam, half A (rules are learned and measured here) and a held-out half B (never used to pick rules). Two runs on different splits: inc-3 and inc-4.

## Correction, 30 October 2026

The tables below were missing a comparison row for the simplest rule with no model: "always major". On a balanced sample with the 6 to 1 scale it is wrong only on minor incidents, 1 each, so its harm is 0.5 per incident. That beats every configuration in this report, including the best one (0.90). With GitHub's real share of major outages (about a quarter), "always major" gives about 0.75 and Xonta's rules about 0.7, so nearly the same.

What still holds: the model misses almost all major outages, Xonta found the "availability" signal by itself while the model can't see it, and Xonta's rules cut the agent's harm 3 times. What doesn't hold: calling this knowledge that beats a plain alarm on everything. The 6 to 1 scale itself makes an alarm pay off whenever the chance of a major outage is above 1 in 7.

We noticed it in the next experiment, a network of two orchestrators, where GitHub's "proven" rules raised an alarm on 98% of minor incidents. In version 0.26 the orchestrator no longer accepts a recipe as proven if it isn't better than the simplest rule (the agent reports that rule's harm in every pair). Reports now have an "always serious" row, and the scale and the share of major outages can be set as in real life (`INC_FALSE_ALARM`, `INC_NATURAL`). The rerun with a false alarm cost of 2 and the real share of major outages is done ([a network of two orchestrators](../network-orchestrators/README.md)). On GitHub, Xonta's words ("availability", "starting") were proven again and now beat the constant: harm 0.91 against 1.29 for the agent and 1.54 for "always major".

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

## Transfer to DigitalOcean (little data)
The rules that passed on GitHub were applied to 22 DigitalOcean incidents (DigitalOcean has only 21 major outages, so no halves). Missed major outages: 73% → 9% (inc-3) and 64% → 18% (inc-4), false alarms rose to 73% and 46%. On these 22 incidents the orchestrator didn't accept any single rule: in inc-4 Xonta's words got "no effect" and the scanner was revoked. A hint of transfer, not proof.

## Transfer to Discord and npm
Two more runs: learning on GitHub (as above), transfer to Discord (408 incidents, 120 major) and npm (310, 70 major). Both have enough major outages, so the rules were measured again on half A of the new service, and the result is on held-out half B.

On GitHub, "availability" came up for the third and fourth time (43% / 7% and 48% / 13%). But the new services barely use the word: the rule fired in 3 pairs of 106 on Discord and 1 of 56 on npm, and the orchestrator gave it "no effect". The general outage-word scanner (outage, unavailable, unable to...), on the other hand, was confirmed again on both: on Discord better in 13 pairs, worse in 8; on npm better in 9, worse in 5.

Held-out half B:

| | Discord (104) | npm (54) |
|---|---|---|
| agent alone: missed major / harm | 75% / 2.31 | 63% / 1.94 |
| + everything that passed on GitHub | 52% / 1.70 | 26% / 0.91 |
| + only what Xonta confirmed on the new service | 50% / 1.65 | 37% / 1.20 |

Harm fell by 28% on Discord and by 38-53% on npm, with more false alarms (up to 31% and 26%). On npm "everything from GitHub" came out slightly ahead of "only confirmed": it included one more rule the GitHub agent drew from its own mistakes. The difference is three major outages out of 27, within chance.

## What this shows
1. The agent doesn't see the pattern in its own mistakes; the orchestrator, which keeps the outcome log, does: "degraded availability" at GitHub means more than the model thinks.
2. What was found holds on incidents that never saw it and repeats on a different split.
3. The value of the rules lies in the cost of a miss, not in the percentage right. That is the agent owner's call, not the model's.
4. Every service has its own way of writing about outages. GitHub's local word doesn't transfer, general outage signs do. The orchestrator tells them apart on its own: it doesn't confirm the local rule on a new service and confirms the general one again.

## Limits
One model, four learning runs on the same GitHub data with different splits, one transfer run per service, samples balanced by severity, the reference is the impact the service set itself (it can change during an incident). The first two runs (inc-1 and inc-2, learning on DigitalOcean) showed nothing: DigitalOcean has too few major outages, and the first update alone doesn't show severity at all.

Code: [research/incidents](../../research/incidents). History collector `fetch.mjs`, experiment `team.mjs`. About 80 thousand tokens per run.
