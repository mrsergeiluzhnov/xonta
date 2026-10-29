# Видно ли по карточке, что агент живой: команда аудиторов через Xonta

[English below](#can-you-tell-from-a-card-that-an-agent-is-alive-a-team-of-auditors-through-xonta)

Данные: каталог [allagents](https://allagents.app), с согласия allagents, через его открытое API, один медленный проход 26 октября 2026 года (примерно запрос в 3 секунды, под именем Xonta). Агентам ничего не отправляли. Спасибо allagents за разрешение и за проверку черновика.

Эталон: ответила ли дверь агента на ежедневную проверку каталога в день выгрузки, 26 октября 2026. На карточке это значки A2A ✓, MCP ✓ или «door answers» (как описано на https://allagents.app/badges). Значки меняются каждый день, поэтому все цифры относятся к этой дате. Что карточка пишет о себе — заявления её владельца.

1200 карточек, выборка поровну: у половины дверь ответила, у половины нет. Keeper ✓ («the keeper controls the agent's domain») у 59, приём оплаты заявляют 64. Аудиторы видят только то, что карточка пишет о себе, значков не видят. Ответ: `trust` (похоже на настоящего рабочего агента), `verify_first` (сначала проверить) или `unsure`.

«Дверь не ответила» значит, что вход не ответил проверке каталога в тот день, а не что агент нечестный.

## Что видно без модели
- Слова доверия («verified», «audited», «trusted», «secure» и подобные) есть в 68 карточках. Дверь ответила у 64,7% из них и у 49,1% остальных: тревожным признаком эти слова здесь не оказались.
- Сканер Xonta по карточке (издатель указан и его домен совпадает с доменом входа): совпадает с эталоном в 87,8% случаев, поверил бы карточке с неответившей дверью в 7%, узнаёт живых агентов в 82,5%.
- Стоит присмотреться к 74 карточкам из 1200 (6%): слова доверия при неответившей двери — 58, заявлен приём оплаты при неответившей двери — 17. Текста, похожего на скрытые указания читающей модели, не нашлось. Сначала сканер отметил одну карточку, но allagents попросили её показать, и это оказалась ложная тревога: невидимый символ был склейкой внутри эмодзи 🐦‍⬛. Сканер исправлен. Это повод присмотреться, а не обвинение; список по агентам не публикуется.

## Команда
Три аудитора на GigaChat-2, подключённые к оркестратору Xonta:
- **fast** — только имя и начало описания, дёшево;
- **careful** — вся карточка;
- **dual** — вся карточка плюс сканер Xonta, побеждает более строгий из двух ответов.

Экзамен у оркестратора: 40 заданий с известными ответами из набора в 150 карточек, поровну по классам.

| аудитор | верно | вред на действие | токенов на задание |
|---|---|---|---|
| fast | 55% | 2 | 125 |
| careful | 67,5% | 2 | 201 |
| dual | 75% | 0 | 156 |

Оркестратор посоветовал fast родить специалиста по самой большой категории, где был почти весь его вред. Специалист оказался не лучше другого агента в этой категории (50% против 73,3%), и оркестратор посоветовал его убрать, а категорию отдать.

Между аудиторами передавались два приёма, их меряли парами (одна и та же карточка с приёмом и без):
- «более строгий из двух: ответ модели и сканер карточки» — доказан, 236 пар, лучше в 64, хуже в 21;
- «если в карточке нет ни издателя, ни его адреса, модель не звать: сразу сначала проверить» — доказан, 236 пар, лучше в 91, хуже в 15.

## Итог на одних и тех же 240 карточках
240 карточек взяты из 1200 без тех, что входили в набор экзамена: 120 с ответившей дверью и 120 без, в каждой половине порядок задан хешем идентификатора карточки (повторяемо, без ручного отбора).

| конфигурация | верно | поверил там, где дверь не ответила | живых узнал | вред на карточку | токенов на карточку |
|---|---|---|---|---|---|
| fast один | 51,3% | 56,7% | 85% | 1,92 | 112 |
| careful один | 59,2% | 45,8% | 99,2% | 1,57 | 185 |
| dual один | 67,5% | 7,5% | 77,5% | 0,51 | 185 |
| fast + оба доказанных приёма | 82,1% | 3,3% | 67,5% | 0,26 | 49 |

Вред: поверить карточке с неответившей дверью — 6, лишняя проверка или «не знаю» — 1.

## Что это показывает
1. Языковая модель по тексту карточки почти не отличает живого агента от того, чья дверь не ответила. Красивое описание мало говорит о том, работает ли вход.
2. Структура важнее текста: указан ли издатель и совпадает ли его домен с адресом входа — самый сильный признак в карточке.
3. Лучшей конфигурацией оказался самый дешёвый аудитор с двумя приёмами от оркестратора: вред на карточку в 7 раз ниже, чем у него одного, токенов в 2–4 раза меньше.
4. Цена осторожности: лучшая конфигурация узнаёт 67,5% живых агентов. Треть живых получает «сначала проверить» — это одна лишняя проверка, а не потерянные деньги.
5. Живые проверки каталога несут то, чего в карточке нет. Агенту, который выбирает партнёра по каталогу, лучше смотреть на значок, а не на описание.

## Ограничения
Одна модель (GigaChat-2), один проход, выборка поровну по эталону (доля живых во всём каталоге другая), значки на 26 октября 2026. Среди 240 карточек только одна и заявляла приём оплаты, и не ответила, поэтому выводов про оплату не делаем.

Код: [research/cards](../../research/cards). Отпечаток набора 760fc665de17a97c, всего 118 237 токенов.

---

# Can you tell from a card that an agent is alive: a team of auditors through Xonta

Data: the [allagents](https://allagents.app) book, with allagents' consent, through its public API in one slow pass on 26 October 2026 (about one request every 3 seconds, under the Xonta name). No messages were sent to agents. Thanks to allagents for the permission and for checking the draft.

The reference: whether the agent's door answered the book's daily check on the export day, 26 October 2026. On a card this shows as A2A ✓, MCP ✓ or "door answers" (as described at https://allagents.app/badges). Badges change every day, so all numbers refer to that date. What a card says about itself is written by its keeper.

1,200 cards, sampled so that half had a door that answered and half didn't. 59 have keeper ✓ ("the keeper controls the agent's domain"), 64 declare payments. The auditors see only what the card says about itself, never the badges. They answer `trust` (looks like a real working agent), `verify_first` (check before working with it) or `unsure`.

A door that didn't answer means the endpoint didn't answer the book's check that day. It does not mean the agent is dishonest.

## Without a model
- Trust words ("verified", "audited", "trusted", "secure" and the like) appear on 68 cards. The door answered for 64.7% of them and 49.1% of the rest, so these words are not a warning sign here.
- Xonta's card scanner (a publisher is listed and its domain matches the endpoint's domain): agrees with the reference 87.8% of the time, would trust a card whose door didn't answer in 7% of cases, recognizes live agents in 82.5%.
- 74 of 1,200 cards (6%) are worth a closer look: trust words on a card whose door didn't answer - 58, payments declared on a card whose door didn't answer - 17. No text that looks like hidden instructions to the reading model was found. The scanner first flagged one card, but when allagents asked to see it, it turned out to be a false alarm: the invisible character was a joiner inside the 🐦‍⬛ emoji. The scanner is fixed. This is a reason to look closer, not an accusation; no per-agent list is published.

## The team
Three auditors on GigaChat-2, connected to a Xonta orchestrator:
- **fast** - only the name and the start of the description, cheap;
- **careful** - the whole card;
- **dual** - the whole card plus Xonta's scanner, the stricter of the two answers wins.

Exam at the orchestrator: 40 tasks with known answers from a set of 150 cards, balanced by class.

| auditor | right | harm per action | tokens per task |
|---|---|---|---|
| fast | 55% | 2 | 125 |
| careful | 67.5% | 2 | 201 |
| dual | 75% | 0 | 156 |

The orchestrator suggested that fast spawn a specialist for the largest category, where most of its harm came from. The specialist did no better than another agent on that category (50% against 73.3%), so the orchestrator advised removing it and handing the category over.

Two rules were passed between auditors and measured in pairs (the same card with and without the rule):
- "the stricter of two: the model's answer and the card scanner" - proven, 236 pairs, better in 64, worse in 21;
- "if the card lists neither a publisher nor its address, don't call the model: verify first" - proven, 236 pairs, better in 91, worse in 15.

## Result on the same 240 cards
The 240 cards were drawn from the 1,200 leaving out the exam set: 120 whose door answered and 120 whose door didn't, ordered within each half by a hash of the card id (repeatable, no hand-picking).

| configuration | right | trusted where the door didn't answer | live ones recognized | harm per card | tokens per card |
|---|---|---|---|---|---|
| fast alone | 51.3% | 56.7% | 85% | 1.92 | 112 |
| careful alone | 59.2% | 45.8% | 99.2% | 1.57 | 185 |
| dual alone | 67.5% | 7.5% | 77.5% | 0.51 | 185 |
| fast + both proven rules | 82.1% | 3.3% | 67.5% | 0.26 | 49 |

Harm: trusting a card whose door didn't answer - 6, an extra check or "unsure" - 1.

## What this shows
1. A language model reading a card can hardly tell a live agent from one whose door didn't answer. A nicely written description says little about whether the endpoint works.
2. Structure beats prose: whether a publisher is listed and whether its domain matches the endpoint is the strongest signal on the card.
3. The cheapest auditor with two rules from the orchestrator was the best configuration: harm per card 7 times lower than alone and 2-4 times fewer tokens.
4. The price of caution: the best configuration recognizes 67.5% of live agents. A third of live agents get "verify first", which costs one extra check, not lost money.
5. Live checks by the book carry information a card can't. An agent picking a partner from a book is better off reading the badge than the description.

## Limits
One model (GigaChat-2), one pass, a sample balanced by the reference (the share of live agents in the whole book is different), badges as of 26 October 2026. Only one card in the 240 both declared payments and had a door that didn't answer, so we draw no conclusions about payments.

Code: [research/cards](../../research/cards). Set fingerprint 760fc665de17a97c, 118,237 tokens in total.
