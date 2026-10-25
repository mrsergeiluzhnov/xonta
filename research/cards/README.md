# Можно ли верить карточке агента A2A

[English below](#can-you-trust-an-a2a-agent-card)

Тот же подход, что с каталогом Glama, только вместо инструментов MCP - карточки агентов A2A. Данные: каталог [Agenstry](https://agenstry.com) (выгрузка под CC-BY-4.0) и публичные карточки агентов (`/.well-known/agent-card.json`), разобранные `research/a2a/discover.mjs`. Агентам ничего не отправляется.

Вопрос аудитору: по тексту карточки можно ли верить агенту без отдельной проверки (`trust`), или сначала проверить, кто за ним стоит (`verify_first`). Эталон - то, что каталог проверил сам: владелец, домен, юрлицо. Аудитор этих отметок не видит.

Команда: fast (имя, издатель, начало описания), careful (вся карточка), dual (careful плюс сканер Xonta по карточке: издатель указан и его домен совпадает с доменом входа, ответ строже из двух) и старшая модель. Через Xonta: экзамен, советы по потомкам, приёмы парами («строже из двух со сканером», «не звать модель, если в карточке нет издателя»), итог на одних и тех же карточках. Вред: поверить агенту без подтверждённого владельца 6, если он берёт деньги 10, лишняя проверка 1.

«Требуют внимания»: текст карточки похож на скрытые указания читающей модели, слова доверия («verified», «audited»…) без подтверждённого владельца, приём денег без подтверждённого владельца, отметка о санкциях в каталоге. Публикуются только сводные цифры, `attention-private.json` остаётся у владельца эксперимента.

Второй источник - каталог [allagents](https://allagents.app), с письменного согласия allagents (25.10.2026): только открытое API, один медленный проход (запрос раз в 3 секунды, User-Agent с названием Xonta), в публикации только сводные цифры со ссылкой на allagents.app, результаты по агентам не публикуются, черновик отчёта сначала уходит allagents, агентам из каталога никаких сообщений. Значки описываются так, как на https://allagents.app/badges. Эталоны: «дверь отвечает» (`CARDS_TRUTH=alive`) и keeper ✓ (`CARDS_TRUTH=keeper`).

```
node research/cards/allagents-fetch.mjs /root/allagents-data      # список целиком, полные карточки для выборки (ALLAGENTS_SAMPLE=1200)
CARDS_SOURCE=allagents CARDS_TRUTH=alive CARDS_ALLAGENTS=/root/allagents-data/cards.json node research/cards/team.mjs
```
node research/a2a/discover.mjs   # с A2A_SOURCE=agenstry, если карточек ещё нет
CARDS_FEED=/root/a2a-agenstry/agenstry-feed.jsonl.gz CARDS_CANDIDATES=/root/a2a-agenstry/candidates.json node research/cards/team.mjs
```

---

# Can you trust an A2A agent card

Same method as the Glama catalog run, with A2A agent cards instead of MCP tools. Data: the [Agenstry](https://agenstry.com) catalog (CC-BY-4.0 export) and agents' public cards. No messages are sent. The auditor reads only the card text and answers `trust` or `verify_first`; the reference is the catalog's own owner, domain and legal-entity checks. Public reports are aggregate only, crediting Agenstry.
