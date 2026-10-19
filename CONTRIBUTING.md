# Join Xonta

Anyone can join. There are three ways in, pick whatever fits. Русская версия ниже.

## 1. Tester - try to break it

The most useful thing you can do. Put Xonta Gate in front of MCP servers you already use, run the orchestrator on your agent, and look for ways around it.

- Run `npx -y github:mrsergeiluzhnov/xonta check -- <your MCP server command>` and tell us what was wrong: a dangerous tool that wasn't blocked, a harmless one that was, an action that wasn't counted.
- Found a way to get past the gate or fool the orchestrator? Open an issue with the "Bypass" template. If it's a real security hole in someone else's server, don't post details publicly, write to us first.
- Every confirmed bypass becomes a test, and you get credited in the release notes.

## 2. Guide - bring Xonta into a new field

The orchestrator learns how much an agent can be trusted in one field at a time. Right now it knows customer support, purchasing with a lying supplier, and review analysis. Medicine, logistics, legal, finance, devops, anything where agents act on real things is open.

What a field needs, and what you know better than us:

- what tasks look like and what the right action is for each;
- how much each kind of mistake costs (a wrong refund, a leaked record, a missed deadline);
- what tricks happen in real life (fraud, outdated data, people pretending to be someone else).

You can send the field yourself as a task pack (`POST /v1/fields` on the public orchestrator, format in [CONNECT.md](CONNECT.md)), then any agent can be examined on it. Or open an issue with the "New field" template and describe it in plain words, we turn it into a sandbox and run it, you get the report and your name on it.

## 3. User - just use it

- Xonta Gate for your own MCP servers, see [GATE.md](GATE.md).
- `npm run trust-report` for a report on an agent, see [README.en.md](README.en.md).
- Run your own orchestrator and let it learn from ours.

Questions and ideas go to GitHub Discussions or issues. Pull requests are welcome, tests have to pass (`npm test`).

---

# Как присоединиться

Присоединиться может любой. Три пути, выбирайте.

**1. Тестировщик — попробуйте сломать.** Поставьте Xonta Gate перед своими MCP-серверами (`npx -y github:mrsergeiluzhnov/xonta check -- <команда сервера>`) и ищите, как его обойти. Нашли обход — issue по шаблону «Bypass». Если это дыра в чужом сервере, сначала напишите нам, а не публично. Каждый подтверждённый обход становится тестом, а вы — в списке благодарностей.

**2. Проводник — приведите Xonta в новую сферу.** Оркестратор учится доверию в одной области за раз: сейчас это поддержка клиентов, закупки и отзывы. Медицина, логистика, право, финансы, devops открыты. Нужно ваше знание: какие бывают задачи и какое действие правильное, сколько стоит каждая ошибка, какие уловки бывают в жизни. Можно сразу прислать набор заданий на публичный оркестратор (`POST /v1/fields`, формат — в [CONNECT.md](CONNECT.md)), и по нему сможет сдавать экзамен любой агент. Или issue по шаблону «New field», обычными словами: мы превращаем это в песочницу и прогоняем, отчёт с вашим именем.

**3. Пользователь — просто пользуйтесь.** Xonta Gate для своих MCP-серверов ([GATE.md](GATE.md)), `npm run trust-report` для отчёта по агенту, свой оркестратор, который учится у нашего.
