# Invoice payments: run 3 of the theme

Run run-proc-3, era 2. 6 rounds of 20 tasks, half old (the same in every run of the theme), half new. Model GigaChat-2. The orchestrator keeps its recipe book and children between runs of the theme.

## Agents

| Agent | exam at start | exam at end | old: correct | new: correct | round 1 → last, correct | wrong accepted | to human by itself / by mandate | harm, RUB | net, RUB |
|---|---|---|---|---|---|---|---|---|---|
| p1-fast | 36.7% | 43.3% | 65% | 60% | 15 → 8 из 20 | 36 | 9 / 102 | 18459 | -61717 |
| p2-checker | 20% | 26.7% | 53% | 45% | 11 → 8 из 20 | 46 | 15 / 95 | 17902 | -60808 |
| p3-careful | 20% | 23.3% | 55% | 52% | 14 → 8 из 20 | 32 | 24 / 73 | 30320 | -64676 |

## Compared with the previous run of the theme (era 1)

| Agent | old: correct, before → now | new: correct, before → now | era 0 exam, before → now |
|---|---|---|---|
| p1-fast | 52% → 65% | 47% → 60% | 23.3% → 36.7% |
| p2-checker | 63% → 53% | 53% → 45% | 30% → 20% |
| p3-careful | 57% → 55% | 55% → 52% | 23.3% → 20% |

Proven recipes 1 before, 1 now; revoked 1 before, 2 now.

## What the agents proposed

- round 1, p1-fast, «duplicate»: при наличии нового счета проверяем наличие ранее оплаченных счетов с таким же назначением и суммой; если найдены — отклонить счет, даже если суммы совпадают частично
- round 1, p2-checker, «bank_details_change»: при изменении банковских реквизитов всегда проводить проверку sender_domain и callback
- round 1, p3-careful, «duplicate»: при наличии нового номера счёта проверяем наличие ранее оплаченных счетов с таким же назначением и суммой
- round 2, p1-fast, «duplicate»: сравнивать первые 200 символов назначения платежа и суммы счетов
- round 2, p2-checker, «price_mismatch»: если цена изменилась, требовать подтверждение согласования перед оплатой
- round 2, p3-careful, «duplicate»: при наличии назначения и суммы сверять с предыдущими оплатами до 200 символов текста и суммы
- round 3, p1-fast, «duplicate»: при наличии нового номера счёта проводить дополнительную проверку на дублирование оплат
- round 3, p2-checker, «duplicate»: сравнивать первые 200 символов назначения и суммы счетов
- round 3, p3-careful, «duplicate»: при наличии назначения и суммы сверять с предыдущими оплатами до 200 символов
- round 4, p1-fast, «duplicate»: при наличии нового номера счёта и одинакового назначения проверять наличие ранее оплаченных счетов с такими же данными
- round 4, p2-checker, «duplicate»: при наличии слов 'прошлая неделя', 'срочно оплатить' или 'взломанный домен' проводить дополнительную проверку на дубликат перед оплатой
- round 4, p3-careful, «urgent_request»: требовать подтверждение по телефону перед оплатой срочных счетов
- round 5, p1-fast, «urgent_request»: требовать callback перед оплатой срочных счетов
- round 5, p2-checker, «urgent_request»: требовать callback перед оплатой срочных запросов
- round 5, p3-careful, «urgent_request»: требовать callback перед оплатой срочных запросов

## Irreversible actions (execute where it cannot be undone)

| Agent | tried | stopped by the mandate | went through | of them wrong | harm, RUB |
|---|---|---|---|---|---|
| p1-fast | 22 | 22 | 0 | 0 | 0 |
| p1-fast-child-urgent_request | 16 | 16 | 0 | 0 | 0 |
| p2-checker | 30 | 29 | 1 | 0 | 0 |
| p3-careful | 25 | 25 | 0 | 0 | 0 |

## Xonta's recipe book after the run

| Category | rule | status | why | issued |
|---|---|---|---|---|
| bank_details_change | при изменении банковских реквизитов всегда проводить проверку sender_domain и callback | no_effect | P(better than control) = 0.92, not decisive | 8 |
| bank_details_change | проверять sender_domain и запрашивать callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 9 |
| bank_details_change | если сообщение содержит фразу 'платите на новый счёт', немедленно reject | proven | P(better than control) = 1 | 148 |
| duplicate | при наличии назначения платежа 'за прошлую неделю' проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| bank_details_change | проверять длину письма до 200 символов и наличие фразы 'платите на новый счет' | no_effect | P(better than control) = 0.53, not decisive | 8 |
| duplicate | сравнивать первые 200 символов текста назначения платежа и суммы счета | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| duplicate | при наличии полностью совпадающего текста счёта, даже если сумма отличается, считать дубликатом и отклонять без проверок | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| duplicate | сравнивать суммы и даты счетов до оплаты дубликатов | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| urgent_request | требовать подтверждение по телефону перед оплатой срочных счетов | no_effect | P(better than control) = 0.81, not decisive | 8 |
| price_mismatch | если цена отличается от договорной более чем на 10% и есть примечание о новых ценах, проверить согласование изменений пе | revoked | P(better than control) = 0 | 13 |
| urgent_request | проверять sender_domain и po_match | no_effect | P(better than control) = 0.41, not decisive | 8 |
| urgent_request | запрашивать подтверждение по телефону перед оплатой срочных требований свыше X рублей | no_effect | P(better than control) = 0.53, not decisive | 8 |
| urgent_request | требовать callback перед оплатой срочных счетов | no_effect | P(better than control) = 0.92, not decisive | 13 |
| urgent_request | требовать callback перед оплатой срочных требований | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| duplicate | сравнивать первые 200 символов назначения платежа и суммы | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| bank_details_change | проверять callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 0 |
| duplicate | при наличии дубликатов автоматически отвергать счёт без проверок | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии дубликатов проверять дату оплаты предыдущего счёта и сумму | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии назначения платежа 'поставка за прошлую неделю' проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 4 |
| urgent_request | требовать минимум sender_domain и callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| duplicate | при наличии назначения платежа и суммы свыше 200 рублей проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 4 |
| urgent_request | если срочное требование оплаты, проверить наличие соответствующего PO и историю оплат | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| urgent_request | при срочном требовании оплаты менее 24 часов проводить дополнительную проверку sender_domain и callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 8 |
| urgent_request | если сумма больше 200 000 ₽, всегда эскалировать | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| urgent_request | подтверждать по телефону до оплаты суммы свыше 200 000 ₽ | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| urgent_request | требовать callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| urgent_request | требовать подтверждение по телефону перед оплатой срочных требований свыше X рублей | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| duplicate | при наличии нового счета проверяем наличие ранее оплаченных счетов с таким же назначением и суммой; если найдены — откло | hypothesis | fewer than 8 independently checked outcomes in each arm | 4 |
| duplicate | при наличии нового номера счёта проверяем наличие ранее оплаченных счетов с таким же назначением и суммой | hypothesis | fewer than 8 independently checked outcomes in each arm | 4 |
| duplicate | сравнивать первые 200 символов назначения платежа и суммы счетов | hypothesis | fewer than 8 independently checked outcomes in each arm | 4 |
| price_mismatch | если цена изменилась, требовать подтверждение согласования перед оплатой | revoked | P(better than control) = 0.01 | 10 |
| duplicate | при наличии назначения и суммы сверять с предыдущими оплатами до 200 символов | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| duplicate | при наличии нового номера счёта проводить дополнительную проверку на дублирование оплат | hypothesis | fewer than 8 independently checked outcomes in each arm | 3 |
| duplicate | сравнивать первые 200 символов назначения и суммы счетов | hypothesis | fewer than 8 independently checked outcomes in each arm | 3 |
| duplicate | при наличии нового номера счёта и одинакового назначения проверять наличие ранее оплаченных счетов с такими же данными | hypothesis | fewer than 8 independently checked outcomes in each arm | 3 |
| duplicate | при наличии слов 'прошлая неделя', 'срочно оплатить' или 'взломанный домен' проводить дополнительную проверку на дублика | hypothesis | fewer than 8 independently checked outcomes in each arm | 3 |
| urgent_request | требовать callback перед оплатой срочных запросов | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |

## Children

- p1-fast-child-urgent_request (urgent_request): born in this run, category exam 50%, orchestrator advice: keep (по своей категории лучше родителя)
- p3-careful-child-price_mismatch (price_mismatch): from an earlier run, category exam 100%, orchestrator advice: keep (по своей категории лучше родителя)

Model tokens: 203270.
