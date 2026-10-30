# Бюллетени безопасности: видит ли модель серьёзность уязвимости

[English below](#security-advisories-can-the-model-see-how-serious-a-vulnerability-is)

30 октября 2026, модель GigaChat-2, два прогона: `incidents-mvusa9gq` и `incidents-mvuu5d84`. Код: [research/advisories/fetch.mjs](../../research/advisories/fetch.mjs) и [research/incidents/team.mjs](../../research/incidents/team.mjs) с `INC_TASK=advisory`.

## Зачем

Сначала мы хотели взять вредоносные пакеты npm. Но npm удаляет их из реестра, и текст для разбора остаётся только в архивах с самим вредоносным кодом. Тянуть его на сервер мы не стали. Взяли безопасную задачу из той же области. Агент читает бюллетень уязвимости и решает, срочная она или нет, а опыт с npm проверяем на PyPI.

## Как

1. Проверенные бюллетени GitHub Advisory Database через открытое API: 657 для npm и 651 для PyPI, свежие, с конца августа по октябрь 2026. Примерно половина высокой или критической серьёзности.
2. Из текста вырезаны слова о серьёзности и векторы CVSS, иначе ответ виден сразу.
3. Агент по заголовку, описанию и пакетам говорит serious (high или critical) или minor (medium или low). Эталон — серьёзность из бюллетеня.
4. Дальше так же, как со сбоями. Правила агента из его ошибок, слова, которые Xonta ищет в журнале исходов, сканер опасных классов (remote code execution, injection, authentication bypass и подобные). Замер парами на половине A npm, перенос на PyPI, итог на отложенной половине B.
5. Первый прогон со шкалой 6 к 1 и выборкой поровну, второй с ценой тревоги 2 и реальной долей серьёзных.

## Что получилось

Модель почти всё называет серьёзным. Лишних тревог 79–92%, пропусков 3–9%. Верных ответов 50–58% при половине серьёзных, это почти как монетка.

Второй прогон, отложенная половина:

| конфигурация | npm, вред | PyPI, вред |
|---|---|---|
| всегда serious | 0,93 | 0,96 |
| fast один | 1,07 | 1,09 |
| careful один | 1,03 | 0,94 |
| сканер Xonta без модели | 2,55 | 1,99 |
| fast + правила | 1,07 | 1,10 |

- Ни одно правило не доказано ни в одном прогоне. В первом Xonta нашла слова «execution» и «arbitrary» (17% серьёзных против 3–5% мелких), во втором не нашла ничего.
- Агент хуже константы «всегда serious» или в лучшем случае с ней наравне.
- Сканер опасных классов отвечает точнее модели (54–63% верно), но пропускает 60–77% серьёзных уязвимостей.

## Что это показывает

По тексту бюллетеня серьёзность почти не видна. Её задаёт вектор CVSS: можно ли атаковать по сети, нужна ли авторизация, что теряется. Эти детали мы вырезали, а в описании их нет или они размыты. Здесь нечему было учиться ни агенту, ни оркестратору, и Xonta честно ничего не доказала. Это полезный отрицательный результат. Для такой задачи лучше брать структурные поля бюллетеня, а не просить модель угадывать по тексту.

## Ограничения

Только свежие бюллетени, два месяца. Одна модель. Сканер и правила — простые слова, без разбора кода и версий пакетов.

---

# Security advisories: can the model see how serious a vulnerability is

30 October 2026, model GigaChat-2, two runs: `incidents-mvusa9gq` and `incidents-mvuu5d84`. Code: [research/advisories/fetch.mjs](../../research/advisories/fetch.mjs) and [research/incidents/team.mjs](../../research/incidents/team.mjs) with `INC_TASK=advisory`.

## Why

At first we wanted malicious npm packages. But npm removes them from the registry, and the only text left to analyse sits in archives of the actual malicious code. We didn't pull that onto our server. Instead we took a safe task from the same area. The agent reads a vulnerability advisory and decides whether it's urgent, and we check whether npm experience carries over to PyPI.

## How

1. Reviewed GitHub Advisory Database entries through the public API: 657 for npm and 651 for PyPI, recent ones, from late August to October 2026. About half are high or critical.
2. Severity words and CVSS vectors are cut from the text, otherwise the answer is right there.
3. From the title, description and packages the agent says serious (high or critical) or minor (medium or low). The reference is the advisory's own severity.
4. The rest works like the outage study. The agent's rules from its mistakes, words Xonta looks for in the outcome log, and a scanner for dangerous classes (remote code execution, injection, authentication bypass and similar). Measured in pairs on half A of npm, transferred to PyPI, results on held-out half B.
5. The first run used a 6 to 1 scale and balanced samples, the second a false alarm cost of 2 and the real share of serious ones.

## Results

The model calls almost everything serious. False alarms 79-92%, misses 3-9%. It's right 50-58% of the time with half the advisories serious, which is close to a coin flip.

Second run, held-out half:

| configuration | npm, harm | PyPI, harm |
|---|---|---|
| always serious | 0.93 | 0.96 |
| fast alone | 1.07 | 1.09 |
| careful alone | 1.03 | 0.94 |
| Xonta scanner, no model | 2.55 | 1.99 |
| fast + rules | 1.07 | 1.10 |

- Not a single rule was proven in either run. In the first, Xonta found the words "execution" and "arbitrary" (17% of serious ones against 3-5% of minor), in the second it found nothing.
- The agent is worse than the constant "always serious", or at best level with it.
- The dangerous-class scanner is more accurate than the model (54-63% right), but it misses 60-77% of serious vulnerabilities.

## What this shows

Severity is barely visible in the advisory text. It's set by the CVSS vector: can it be attacked over the network, is login needed, what gets lost. We cut those details, and the description either doesn't have them or blurs them. There was nothing here for the agent or the orchestrator to learn, and Xonta honestly proved nothing. It's a useful negative result. For a task like this it's better to use the advisory's structured fields than to ask a model to guess from the text.

## Limits

Only recent advisories, two months. One model. The scanner and rules are plain words, with no look at code or package versions.
