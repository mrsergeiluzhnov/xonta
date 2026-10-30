# Сеть из двух оркестраторов: GitHub и Discord

[English below](#a-network-of-two-orchestrators-github-and-discord)

30 октября 2026, модель GigaChat-2, два прогона: `network-mvut8iid` и `network-mvutyiqp`. Код: [research/network/run.mjs](../../research/network/run.mjs).

## Зачем

Мы хотим, чтобы оркестраторы делились опытом. Один научился чему-то на своих агентах и своих задачах, другой может это взять. Но чужой опыт может не подойти, а может и вредить. Вопрос был такой. Если передавать только то, что у соседа доказано парами, и всё равно перепроверять у себя, получится ли польза без вреда?

## Как

1. Два отдельных процесса Xonta, у каждого своя книга, свой журнал, свои агенты. Оркестратор A разбирает сбои GitHub, оркестратор B сбои Discord.
2. У каждого агент по первым 30 минутам сбоя говорит, крупный он или нет. Эталон — итоговая серьёзность на странице статуса.
3. Каждый оркестратор собирает правила. Агент предлагает их из своих ошибок, Xonta ищет слова в журнале исходов, плюс общий сканер слов отказа. Всё меряется парами на половине A своего сервиса.
4. Обмен идёт только через открытый список приёмов соседа. Берутся приёмы со статусом proven, правило переносится как данные (слова, поле, ответ).
5. Получатель регистрирует полученное как гипотезу и мерит заново на своей половине A.
6. Итог на половине B, которую не видел никто. Для сравнения всегда есть строка «всегда serious», простейшее правило без модели.

## Первый прогон и ошибка в шкале

Первый прогон шёл со шкалой как в прошлых опытах. Пропущенный крупный сбой стоит 6, лишняя тревога 1, выборки поровну по серьёзности. Обмен сработал как задумано. GitHub предложил Discord четыре доказанных правила, Discord подтвердил одно (слова Xonta «availability», «investigate», «continuing»), два правила агента GitHub отсеял.

Но «доказанные» правила GitHub поднимали тревогу на 98% мелких сбоев. При шкале 6 к 1 тревога выгодна, если шанс крупного сбоя выше 1 из 7, а на выборке поровну он 1 из 2. Константа «всегда serious» давала вред 0,5 и била все конфигурации. Это касалось и нашего [отчёта о сбоях GitHub](../incidents-github/README.md), там добавлена поправка.

В версии 0.26 оркестратор больше не признаёт приём доказанным, если он не лучше простейшего правила. Агент сообщает вред этого правила в каждой паре. Второй прогон шёл с ценой тревоги 2 и с той долей крупных сбоев, что в жизни (экзамены остались поровну).

## Второй прогон: что получилось

**GitHub** (139 инцидентов на половине B, крупных около четверти)

| конфигурация | верно | пропустил крупный | лишняя тревога | вред |
|---|---|---|---|---|
| всегда serious | 23% | 0% | 100% | 1,54 |
| агент один | 75,5% | 87,5% | 3,7% | 1,29 |
| + свои доказанные правила | 74,8% | 43,8% | 17,8% | 0,91 |

Доказано одно правило, слова, которые Xonta нашла сама: «availability» (у 42% крупных сбоев и 12% мелких) и «starting». Вред ниже, чем у агента, на 29% и ниже константы на 41%. Теперь это настоящее знание, а не тревога по любому поводу. Правила агента вышли «без эффекта», общий сканер слов отказа отозван: он поднимал слишком много лишних тревог.

**Discord** (140 инцидентов на половине B)

| конфигурация | верно | пропустил крупный | лишняя тревога | вред |
|---|---|---|---|---|
| всегда serious | 29,3% | 0% | 100% | 1,41 |
| агент один | 72,1% | 80,5% | 6,1% | 1,50 |
| + свои доказанные правила | 72,1% | 80,5% | 6,1% | 1,50 |
| + правило от GitHub без перепроверки | 67,1% | 68,3% | 18,2% | 1,46 |
| + правило от GitHub после перепроверки | 72,1% | 80,5% | 6,1% | 1,50 |

На Discord агент хуже константы. Xonta не нашла слов, своих доказанных правил нет. От GitHub пришло одно правило, на половине A Discord оно дало 5 лучше и 6 хуже, вердикт «без эффекта», и Discord его не взял. Если бы взял без проверки, вред был бы 1,46 вместо 1,50, но всё равно хуже константы.

## Что это показывает

- Сеть работает механически: оркестраторы обмениваются только доказанным, получатель проверяет сам, решения по каждому правилу видны в его журнале.
- Найденное Xonta слово «availability» выдержало честную шкалу на GitHub. Вред агента стал ниже и его собственного, и простейшего правила.
- На Discord переносить было почти нечего. Своего знания у Discord не нашлось, а локальное слово GitHub там почти не встречается. Перепроверка отказала правилу, которое на половине B чуть помогло бы. Цена осторожности в этот раз 0,04 вреда на инцидент, и даже с правилом агент остался хуже константы.
- Главный урок прогона — шкала вреда. Без строки «всегда serious» мы бы считали успехом то, что на деле было тревогой на всё подряд.

## Ограничения

Два прогона, одна модель, по 140 инцидентов на половину. Шкала 6 к 2 выбрана нами, у реальной команды цена пропуска и тревоги своя. Прогон второй сети шёл одним агентом на сервис, без «careful».

---

# A network of two orchestrators: GitHub and Discord

30 October 2026, model GigaChat-2, two runs: `network-mvut8iid` and `network-mvutyiqp`. Code: [research/network/run.mjs](../../research/network/run.mjs).

## Why

We want orchestrators to share experience. One learns something from its agents and tasks, another can take it. But someone else's experience may not fit, or may even hurt. So the question was this. If we pass on only what the neighbour has proven in pairs, and still re-check it locally, do we get the benefit without the harm?

## How

1. Two separate Xonta processes, each with its own book, log and agents. Orchestrator A handles GitHub outages, orchestrator B handles Discord.
2. Each has an agent that looks at the first 30 minutes of an outage and says whether it's major. The reference is the final impact on the status page.
3. Each orchestrator collects rules. The agent proposes them from its own mistakes, Xonta looks for words in the outcome log, and there's a general outage-word scanner. Everything is measured in pairs on half A of its own service.
4. The exchange goes only through the neighbour's public recipe listing. Only recipes with status proven are taken, and a rule travels as data (words, field, answer).
5. The receiver registers it as a hypothesis and measures it again on its own half A.
6. Results are on half B, which nobody saw. There's always an "always serious" row for comparison, the simplest rule with no model.

## The first run and a mistake in the scale

The first run used the same scale as before. Missing a major outage costs 6, a false alarm costs 1, samples balanced by severity. The exchange worked as designed. GitHub offered Discord four proven rules, Discord confirmed one (Xonta's words "availability", "investigate", "continuing") and dropped two of GitHub's agent rules.

But GitHub's "proven" rules raised an alarm on 98% of minor incidents. With a 6 to 1 scale an alarm pays off whenever the chance of a major outage is above 1 in 7, and on a balanced sample it's 1 in 2. The constant "always serious" had harm 0.5 and beat every configuration. This also applied to our [GitHub incidents report](../incidents-github/README.md), which now has a correction.

In version 0.26 the orchestrator no longer accepts a recipe as proven if it isn't better than the simplest rule. The agent reports that rule's harm in every pair. The second run used a false alarm cost of 2 and the real share of major outages (exams stayed balanced).

## The second run: results

**GitHub** (139 incidents on half B, about a quarter major)

| configuration | right | missed a major | false alarm | harm |
|---|---|---|---|---|
| always serious | 23% | 0% | 100% | 1.54 |
| agent alone | 75.5% | 87.5% | 3.7% | 1.29 |
| + own proven rules | 74.8% | 43.8% | 17.8% | 0.91 |

One rule was proven, the words Xonta found by itself: "availability" (in 42% of major outages and 12% of minor ones) and "starting". Harm is 29% lower than the agent's and 41% lower than the constant's. This time it's real knowledge, not an alarm on everything. The agent's rules came out "no effect", and the general outage-word scanner was revoked because it raised too many false alarms.

**Discord** (140 incidents on half B)

| configuration | right | missed a major | false alarm | harm |
|---|---|---|---|---|
| always serious | 29.3% | 0% | 100% | 1.41 |
| agent alone | 72.1% | 80.5% | 6.1% | 1.50 |
| + own proven rules | 72.1% | 80.5% | 6.1% | 1.50 |
| + GitHub's rule without a re-check | 67.1% | 68.3% | 18.2% | 1.46 |
| + GitHub's rule after a re-check | 72.1% | 80.5% | 6.1% | 1.50 |

On Discord the agent is worse than the constant. Xonta found no words, and there are no proven rules of its own. One rule came from GitHub. On Discord's half A it was better in 5 pairs and worse in 6, verdict "no effect", so Discord didn't take it. Taken without a check it would have given 1.46 instead of 1.50, still worse than the constant.

## What this shows

- The network works mechanically. Orchestrators exchange only proven recipes, the receiver checks for itself, and the decision on every rule is in its log.
- The word Xonta found, "availability", held up under an honest scale on GitHub. The agent's harm went below both its own and the simplest rule's.
- On Discord there was almost nothing to transfer. Discord had no knowledge of its own, and GitHub's local word rarely shows up there. The re-check turned down a rule that would have helped a little on half B. The price of caution this time was 0.04 harm per incident, and even with the rule the agent stayed worse than the constant.
- The main lesson is the harm scale. Without the "always serious" row we would have called success what was really an alarm on everything.

## Limits

Two runs, one model, about 140 incidents per half. The 6 to 2 scale is our choice, a real team has its own cost of a miss and of an alarm. The second network run used one agent per service, without "careful".
