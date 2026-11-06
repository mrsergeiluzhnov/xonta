# Contributing to OCX

[Русский ниже](#как-участвовать-в-ocx)

OCX is an open protocol for orchestrators of AI agents to exchange evidence about how agents behave. Xonta wrote the first draft and the reference implementation, but the protocol is meant to belong to everyone who implements it.

## Ways to help

- **Implement it.** A second, independent implementation is the most valuable contribution right now. Any language. Run `impl/conformance.mjs` against it and open a pull request adding your report to `implementations/`.
- **Find holes.** Open an issue when the text is ambiguous, contradicts itself, or two careful readers could implement it differently. Implementations that disagree are the best bug reports a spec can get.
- **Propose changes.** Open an issue first for anything that changes behaviour. Small fixes (typos, examples, clarifications that change nothing) can go straight to a pull request.
- **Add registry entries.** New claims, categories, evidence types or referral reasons go into §19 by pull request, with a short definition and how a receiver verifies it.

## Rules for changes

1. The prose in `SPEC.md` and the schemas in `schema/` change together. Until 0.4 the prose wins when they disagree; from 0.4 the schemas are the source of truth.
2. Every behaviour change updates `impl/` and its tests, and `impl/test/` and `impl/conformance.mjs` must pass.
3. Use RFC 2119 words only in their capitalised meaning.
4. Backwards-incompatible changes get a new date version (§14.1) and an entry in `CHANGELOG.md`.
5. Examples use `example.com`/`example.org` hosts and never real people, companies or agents.
6. No change may weaken the core rules without an issue and agreement: evidence for anything that acts fast, minimal disclosure, consent for probes, appeals, local sovereignty of every orchestrator.

## Decisions

Until there are several independent implementations, the editors decide after discussion in the issue. Once at least two independent implementations pass the conformance suite, decisions move to their maintainers by rough consensus, and the plan is to move the protocol to a neutral home.

## Licensing of contributions

By contributing you agree that text and schemas are licensed under CC BY 4.0 and code under Apache 2.0, as the rest of the repository.

---

# Как участвовать в OCX

OCX — открытый протокол, по которому оркестраторы ИИ-агентов обмениваются доказательствами того, как ведут себя агенты. Первый черновик и эталонную реализацию написала Xonta, но протокол задуман как общий для всех, кто его реализует.

## Чем помочь

- **Реализовать.** Сейчас самое ценное — вторая, независимая реализация, на любом языке. Прогоните на ней `impl/conformance.mjs` и пришлите pull request с отчётом в папку `implementations/`.
- **Найти дыры.** Создайте issue, если текст двусмысленный, противоречит сам себе или два внимательных читателя реализовали бы его по-разному. Расхождение двух реализаций — лучший отчёт об ошибке, какой только может получить спецификация.
- **Предложить изменение.** Для всего, что меняет поведение, сначала issue. Мелочи (опечатки, примеры, уточнения без изменения смысла) можно сразу присылать pull request.
- **Дополнить реестры.** Новые виды утверждений, категории, типы доказательств и причины направления добавляются в §19 через pull request, с коротким определением и описанием того, как получатель это проверяет.

## Правила изменений

1. Текст `SPEC.md` и схемы в `schema/` меняются вместе. До 0.4 при расхождении прав текст, с 0.4 источником истины становятся схемы.
2. Любое изменение поведения обновляет `impl/` и его проверки; `impl/test/` и `impl/conformance.mjs` должны проходить.
3. Слова из RFC 2119 используются только заглавными и только в их смысле.
4. Несовместимые изменения получают новую версию-дату (§14.1) и запись в `CHANGELOG.md`.
5. В примерах только адреса `example.com` и `example.org`, никаких настоящих людей, компаний или агентов.
6. Основные правила нельзя ослабить без issue и согласия: доказательство для всего, что срабатывает быстро, минимум раскрываемых данных, проверки только с согласия, апелляции, самостоятельность каждого оркестратора.

## Кто решает

Пока независимых реализаций мало, решают редакторы после обсуждения в issue. Когда хотя бы две независимые реализации пройдут проверку совместимости, решения переходят к их авторам по общему согласию, и протокол планируется передать в нейтральную организацию.

## Лицензии

Присылая изменения, вы соглашаетесь, что текст и схемы распространяются по CC BY 4.0, а код по Apache 2.0, как и всё остальное в репозитории.
