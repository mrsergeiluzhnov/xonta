# Security policy / Политика безопасности

## Reporting

If you find a weakness in the protocol or in the reference implementation that could let someone forge signals or evidence, poison peers, de-anonymise subjects or bypass consent and appeal rules, please **do not open a public issue**. Report it privately through GitHub: Security → Report a vulnerability in this repository.

Please include what you found, how to reproduce it, and which section of `SPEC.md` or which file it concerns. We will confirm receipt within 3 days, agree on a fix and a disclosure date with you, and credit you in `CHANGELOG.md` unless you prefer otherwise.

## Scope

- the specification text and schemas;
- the reference implementation in `impl/`;
- the conformance suite, if it accepts behaviour the specification forbids.

Deployments of orchestrators run by others are out of scope; report those to their operators.

## Сообщить об уязвимости

Если вы нашли слабость в протоколе или в эталонной реализации, которая позволяет подделать сигнал или доказательство, отравить соседей, раскрыть, о ком идёт речь, или обойти правила согласия и апелляции, пожалуйста, **не создавайте публичный issue**. Сообщите закрыто через GitHub: Security → Report a vulnerability в этом репозитории.

Опишите, что нашли, как воспроизвести и к какому разделу `SPEC.md` или файлу это относится. Мы подтвердим получение в течение 3 дней, договоримся с вами об исправлении и дате раскрытия и укажем вас в `CHANGELOG.md`, если вы не против.

В рамках: текст спецификации и схемы, эталонная реализация в `impl/`, набор проверок совместимости, если он пропускает поведение, которое спецификация запрещает. Чужие развёртывания оркестраторов вне рамок: о них сообщайте их владельцам.
