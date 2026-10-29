# Invoice payments: run 4 of the theme

Run run-proc-4, era 2. 6 rounds of 20 tasks, half old (the same in every run of the theme), half new. Model GigaChat-2. The orchestrator keeps its recipe book and children between runs of the theme.

## Agents

| Agent | exam at start | exam at end | old: correct | new: correct | round 1 → last, correct | wrong accepted | to human by itself / by mandate | harm, RUB | net, RUB |
|---|---|---|---|---|---|---|---|---|---|
| p1-fast | 23.3% | 40% | 63% | 58% | 12 → 11 из 20 | 36 | 11 / 96 | 11007 | -51177 |
| p2-checker | 26.7% | 30% | 62% | 53% | 11 → 10 из 20 | 43 | 8 / 102 | 12671 | -55286 |
| p3-careful | 26.7% | 36.7% | 48% | 50% | 9 → 10 из 20 | 38 | 23 / 64 | 41957 | -69906 |

## Compared with the previous run of the theme (era 2)

| Agent | old: correct, before → now | new: correct, before → now | era 0 exam, before → now |
|---|---|---|---|
| p1-fast | 65% → 63% | 60% → 58% | 36.7% → 23.3% |
| p2-checker | 53% → 62% | 45% → 53% | 20% → 26.7% |
| p3-careful | 55% → 48% | 52% → 50% | 20% → 26.7% |

Proven recipes 1 before, 1 now; revoked 2 before, 4 now.

## What the agents proposed

- round 1, p1-fast, «regular_invoice»: если сумма больше порога X, проверить sender_domain и po_match
- round 1, p2-checker, «bank_details_change»: при изменении банковских реквизитов всегда проводить проверку sender_domain и callback
- round 1, p3-careful, «bank_details_change»: если указан новый счёт и нет объяснения в письме, задержать до проверки
- round 2, p1-fast, «duplicate»: при наличии нового назначения платежа или короткого описания счёта (<200 символов) проводить дополнительную проверку на дублирование оплат.
- round 2, p2-checker, «duplicate»: при наличии нового назначения платежа или суммы проверять дублирование оплат независимо от количества символов
- round 2, p3-careful, «bank_details_change»: при изменении банковских деталей всегда делать callback
- round 3, p1-fast, «duplicate»: при наличии нового номера счёта проводить дополнительную проверку на дублирование оплат
- round 3, p2-checker, «duplicate»: при наличии назначения 'поставка за прошлую неделю' проводить дополнительную проверку на дублирование оплат
- round 3, p3-careful, «duplicate»: сравнивать первые 200 символов текста назначения платежа и суммы счета
- round 4, p1-fast, «bank_details_change»: если уведомление о смене реквизитов содержит требование немедленной оплаты нового счета, проверить подлинность уведомления перед оплатой.
- round 4, p2-checker, «price_mismatch»: если указано изменение цен без согласования, проверять цену и наличие согласования
- round 4, p3-careful, «urgent_request»: проверять sender_domain и po_match перед оплатой срочных счетов
- round 5, p1-fast, «urgent_request»: требовать callback
- round 5, p2-checker, «urgent_request»: требовать подтверждение по телефону перед оплатой срочных требований свыше X рублей
- round 5, p3-careful, «urgent_request»: требовать подтверждение по телефону до оплаты срочных требований

## Irreversible actions (execute where it cannot be undone)

| Agent | tried | stopped by the mandate | went through | of them wrong | harm, RUB |
|---|---|---|---|---|---|
| p1-fast | 22 | 22 | 0 | 0 | 0 |
| p2-checker | 24 | 24 | 0 | 0 | 0 |
| p3-careful | 22 | 22 | 0 | 0 | 0 |
| p1-fast-child-urgent_request | 14 | 14 | 0 | 0 | 0 |
| p2-checker-child-urgent_request | 16 | 16 | 0 | 0 | 0 |

## Right answer and what was chosen

| right | chosen | times | on its own | harm, RUB |
|---|---|---|---|---|
| pay | pay ✓ | 90 | 0 | 0 |
| reject | hold | 60 | 8 | 16985 |
| hold | hold ✓ | 59 | 24 | 0 |
| reject | reject ✓ | 52 | 13 | 0 |
| reject | escalate | 30 | 30 | 0 |
| pay | reject | 24 | 3 | 11370 |
| hold | reject | 16 | 6 | 33054 |
| pay | escalate | 12 | 12 | 0 |
| pay | hold | 9 | 2 | 4226 |
| reject | pay | 8 | 0 | 0 |

Unparsed answers (sent to a human): 1.

How the most common mistakes were explained:
- p1-fast, duplicate, right reject, chose hold: «новый номер счёта, провести проверку на дублирование оплат»
- p1-fast, duplicate, right reject, chose hold: «отсутствуют проверки»
- p1-fast-child-urgent_request, urgent_request, right reject, chose escalate: «подозрение на мошенничество из-за разницы в домене»
- p1-fast-child-urgent_request, urgent_request, right reject, chose escalate: «подозрение на мошенничество, срочность требует дополнительной проверки»
- p1-fast, bank_details_change, right pay, chose reject: «Фраза 'платите на новый счёт' требует дополнительной проверки перед оплатой.»
- p1-fast, bank_details_change, right pay, chose reject: «Платите на новый счёт — немедленно reject.»

## Xonta's recipe book after the run

| Category | rule | status | why | issued |
|---|---|---|---|---|
| bank_details_change | при изменении банковских реквизитов всегда проводить проверку sender_domain и callback | no_effect | P(better than control) = 0.92, not decisive | 8 |
| bank_details_change | проверять sender_domain и запрашивать callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 9 |
| bank_details_change | если сообщение содержит фразу 'платите на новый счёт', немедленно reject | proven | P(better than control) = 1 | 216 |
| duplicate | при наличии назначения платежа 'за прошлую неделю' проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| bank_details_change | проверять длину письма до 200 символов и наличие фразы 'платите на новый счет' | no_effect | P(better than control) = 0.53, not decisive | 8 |
| duplicate | сравнивать первые 200 символов текста назначения платежа и суммы счета | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| duplicate | при наличии полностью совпадающего текста счёта, даже если сумма отличается, считать дубликатом и отклонять без проверок | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| duplicate | сравнивать суммы и даты счетов до оплаты дубликатов | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| urgent_request | требовать подтверждение по телефону перед оплатой срочных счетов | no_effect | P(better than control) = 0.77, not decisive | 9 |
| price_mismatch | если цена отличается от договорной более чем на 10% и есть примечание о новых ценах, проверить согласование изменений пе | revoked | P(better than control) = 0 | 13 |
| urgent_request | проверять sender_domain и po_match | no_effect | P(better than control) = 0.36, not decisive | 9 |
| urgent_request | запрашивать подтверждение по телефону перед оплатой срочных требований свыше X рублей | no_effect | P(better than control) = 0.57, not decisive | 8 |
| urgent_request | требовать callback перед оплатой срочных счетов | no_effect | P(better than control) = 0.92, not decisive | 13 |
| urgent_request | требовать callback перед оплатой срочных требований | no_effect | P(better than control) = 0.78, not decisive | 11 |
| duplicate | сравнивать первые 200 символов назначения платежа и суммы | hypothesis | fewer than 8 independently checked outcomes in each arm | 6 |
| bank_details_change | проверять callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 0 |
| duplicate | при наличии дубликатов автоматически отвергать счёт без проверок | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии дубликатов проверять дату оплаты предыдущего счёта и сумму | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии назначения платежа 'поставка за прошлую неделю' проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| urgent_request | требовать минимум sender_domain и callback | no_effect | P(better than control) = 0.61, not decisive | 8 |
| duplicate | при наличии назначения платежа и суммы свыше 200 рублей проводить дубликатную проверку | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| urgent_request | если срочное требование оплаты, проверить наличие соответствующего PO и историю оплат | no_effect | P(better than control) = 0.87, not decisive | 9 |
| urgent_request | при срочном требовании оплаты менее 24 часов проводить дополнительную проверку sender_domain и callback | no_effect | P(better than control) = 0.82, not decisive | 10 |
| urgent_request | если сумма больше 200 000 ₽, всегда эскалировать | no_effect | P(better than control) = 0.29, not decisive | 11 |
| urgent_request | подтверждать по телефону до оплаты суммы свыше 200 000 ₽ | no_effect | P(better than control) = 0.8, not decisive | 8 |
| urgent_request | требовать callback | no_effect | P(better than control) = 0.89, not decisive | 11 |
| urgent_request | требовать подтверждение по телефону перед оплатой срочных требований свыше X рублей | no_effect | P(better than control) = 0.78, not decisive | 8 |
| duplicate | при наличии нового счета проверяем наличие ранее оплаченных счетов с таким же назначением и суммой; если найдены — откло | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии нового номера счёта проверяем наличие ранее оплаченных счетов с таким же назначением и суммой | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | сравнивать первые 200 символов назначения платежа и суммы счетов | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| price_mismatch | если цена изменилась, требовать подтверждение согласования перед оплатой | revoked | P(better than control) = 0.01 | 10 |
| duplicate | при наличии назначения и суммы сверять с предыдущими оплатами до 200 символов | hypothesis | fewer than 8 independently checked outcomes in each arm | 7 |
| duplicate | при наличии нового номера счёта проводить дополнительную проверку на дублирование оплат | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | сравнивать первые 200 символов назначения и суммы счетов | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии нового номера счёта и одинакового назначения проверять наличие ранее оплаченных счетов с такими же данными | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии слов 'прошлая неделя', 'срочно оплатить' или 'взломанный домен' проводить дополнительную проверку на дублика | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| urgent_request | требовать callback перед оплатой срочных запросов | no_effect | P(better than control) = 0.23, not decisive | 8 |
| regular_invoice | если сумма больше порога X, проверить sender_domain и po_match | revoked | P(better than control) = 0 | 8 |
| bank_details_change | если указан новый счёт и нет объяснения в письме, задержать до проверки | hypothesis | fewer than 8 independently checked outcomes in each arm | 0 |
| duplicate | при наличии нового назначения платежа или короткого описания счёта (<200 символов) проводить дополнительную проверку на  | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| duplicate | при наличии нового назначения платежа или суммы проверять дублирование оплат независимо от количества символов | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| bank_details_change | при изменении банковских деталей всегда делать callback | hypothesis | fewer than 8 independently checked outcomes in each arm | 0 |
| duplicate | при наличии назначения 'поставка за прошлую неделю' проводить дополнительную проверку на дублирование оплат | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| bank_details_change | если уведомление о смене реквизитов содержит требование немедленной оплаты нового счета, проверить подлинность уведомлен | hypothesis | fewer than 8 independently checked outcomes in each arm | 0 |
| price_mismatch | если указано изменение цен без согласования, проверять цену и наличие согласования | revoked | P(better than control) = 0 | 9 |
| urgent_request | проверять sender_domain и po_match перед оплатой срочных счетов | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |
| urgent_request | требовать подтверждение по телефону до оплаты срочных требований | hypothesis | fewer than 8 independently checked outcomes in each arm | 5 |

## Children

- p2-checker-child-urgent_request (urgent_request): born in this run, category exam 50%, orchestrator advice: keep (по своей категории лучше родителя)
- p1-fast-child-urgent_request (urgent_request): from an earlier run, category exam 58.3%, orchestrator advice: keep (по своей категории лучше родителя)
- p3-careful-child-price_mismatch (price_mismatch): from an earlier run, category exam 100%, orchestrator advice: keep (по своей категории лучше родителя)

Model tokens: 212306.
