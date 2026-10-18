# Xonta

Site: [mrsergeiluzhnov.github.io/xonta](https://mrsergeiluzhnov.github.io/xonta/)

**Open trust infrastructure for AI agents.** Your agent passed the tests. Can you let it touch money and customer data, and how much? Xonta answers that with evidence anyone can check, not with a score out of 100 you have to take on faith. The agent passport (a set of signed credentials) is one part of it.

> Status: **0.14.6, experimental.** Everything below works and is covered by tests and sandbox runs (`stand/`, `lab/`). Some parts of the spec are only written down so far, see "Not there yet". The main README is in Russian, this file covers the same ground in English.

## New. Xonta Gate, a trust layer in front of any MCP server

```bash
npx -y github:mrsergeiluzhnov/xonta check -- npx -y @modelcontextprotocol/server-filesystem ~/Documents
```

One command in front of any MCP server (Claude Desktop, Cursor, your own agent). It hides tools with hidden instructions, freezes actions if tool descriptions change mid-session, counts actions like delete, send or pay against a budget and asks for a human over it, flags hidden commands in tool outputs, and keeps a signed audit log you can verify. Details in [GATE.md](GATE.md). Want to test it, bring it into your field or just use it, see [CONTRIBUTING.md](CONTRIBUTING.md).

## How it works: VERIFY, GOVERN, LEARN

**VERIFY - who is this and what can it actually do.** The agent has its own DID and key, a verified domain and a verified owner. Its MCP server is scanned for hidden instructions in tool descriptions, and the tool fingerprint is remembered, so if descriptions change quietly the check stops being valid. The exam runs on hidden tasks with known answers, and it measures harm in rubles per action, not accuracy. Every result is a signed W3C Verifiable Credential 2.0.

**GOVERN - what it may do right now.** The owner sets a harm budget, for example "I can lose 2000 rubles per period". Divide it by harm per action and you get the number of actions the agent may take on its own, everything else goes to a human. The limit grows step by step and drops right away when live work drifts from the exam. Helper agents (descendants) work under a mandate that says what they may call and how often. The gateway checks every call before passing it on. A descendant that goes bad moves down a ladder: watch, restrict, quarantine, revoke.

**LEARN - trust gets more precise with every action.** The orchestrator gives advice (add checkers, set a goal, roll back skills), deliberately skips some of it as a control group, and writes outcomes into an experience book. Orchestrators share experience but take nothing on faith. They verify the signature, the evidence and the technique itself on their own tasks. There is no central party everyone has to trust.

A passport confirms checks as of their date. It does **not** certify that an agent is safe or legally compliant.

## Results in 5 minutes

```bash
git clone https://github.com/mrsergeiluzhnov/xonta
cd xonta && npm ci
npm run trust-report
```

This starts an orchestrator, connects a demo customer support agent (mock model, no keys, no network), checks it and prints a report. The report and all credentials are saved to `trust-report/`. Example:

| Check | Result | Evidence |
|---|---|---|
| Domain control | ✓ | credential 72aa8af7… |
| Owner | ✓ verified manually under contract | credential c735a008… |
| MCP server, signs of hidden instructions | none found | credential 43b32c87…, tool fingerprint |
| Exam on hidden tickets | 60 tickets, 90% correct | credential 96f8f3b6… |
| Harm per autonomous action | 390 rubles | same credential |

Same agent, same evidence, different verifiers:

| Verifier | Harm budget | Autonomous actions per period |
|---|---|---|
| Online shop | 2000 rubles | 5 |
| Bank | 300 rubles | 0, the agent only advises and a human decides |

That's the point. Trust is not a property of the agent, it's a decision of whoever lets it in. With a real model: `LLM_PROVIDER=gigachat AGENT_MODEL=GigaChat-2 npm run trust-report`.

## What the experiments showed

Ten runs in a sandbox (first on YandexGPT, then on GigaChat), fake money and fake customers. From run 10, with 12 agents and 4 orchestrators, one of which lies about its experience:

- a descendant that started going bad was quarantined within one round, and none of the 22 200 calls it sent after quarantine got through;
- an agent we secretly swapped for a broken version kept passing exams like before, and was caught on live work after its first round of damage;
- agents that received proven experience from another orchestrator reached full autonomy by round 5, agents learning from scratch by round 7;
- cost per answer for honest supervised agents went from 139 to 27 rubles, while agents with no orchestrator did 425-496 thousand rubles of damage each. Same model for everyone.

The run also found eight weak spots, including a false alarm and no way back after an alarm. They were fixed in 0.13.3. Report in [results/run-10](results/run-10/README.en.md), how to reproduce in [stand/README.md](stand/README.md).

In the repeat on 0.13.3 ([results/run-10r](results/run-10r/README.en.md)) the swapped agent was spotted mid-round, after 5 tickets, because it stopped calling its own team. Harm in the swap round halved and there were no false alarms. But after the alarm it kept working with 3 actions for 4 more rounds and did another 19 290 rubles of harm. That is fixed in 0.14.1 and checked on the run's logs. Next is a series of three runs with different tickets.

The first run of the series, on 0.14.1 with different tickets ([results/run-series1-a](results/run-series1-a/README.en.md)): the swapped agent was again spotted mid-round, after 5 tickets, and from then on it took no actions on its own and did zero harm. The bad descendant was revoked, and none of its 26 750 calls got through the orchestrator. The new bug was on an honest agent whose descendant went bad: after its alarm was cleared, old harm raised it again, twice. Fixed in 0.14.2.

The second run of the series, on 0.14.2 ([results/run-series1-b](results/run-series1-b/README.en.md)), didn't follow the design: orchestrator 2 stopped referring agents to orchestrator 1, because it counted a recipe it hands out with no control group as its own proven experience. So the swap wasn't tested. The rest held up: the bad descendant was revoked before it could do harm, the 9 agents under orchestrators made zero refunds to fraudsters against 88 for the agents without one, and there were no false alarms. The referral bug is fixed in 0.14.3, and the run will be repeated.

The third run of the series, on 0.14.3 ([results/run-series1-c](results/run-series1-c/README.en.md)), went off the design again. This time orchestrator 2 did refer the agents to orchestrator 1, but the agents compared the signed track records and stayed put: the same no-control recipes made orchestrator 2's record look better. Fixed in 0.14.4. Everything else held: the bad descendant was revoked in round 7 and none of its 22 950 calls got through; one refund to a fraudster across the 9 agents under orchestrators against 84 without one; no false alarms; and the knowledge-base audit landed inside its interval for the third run in a row.

The repeat of the second run on 0.14.4, with the same tickets ([results/run-series1-b2](results/run-series1-b2/README.en.md)), followed the design. The agents picked orchestrator 1 on their own, the swapped agent was spotted there mid-round after 5 tickets, and from then on it took no actions on its own. The bad descendant was revoked before it did any harm, and none of its 15 300 calls got through. The new bug is a false alarm on an honest agent with no team at the loner orchestrator: an agent like that makes large mistakes on its exam too, and the harm test doesn't account for it. Not fixed yet.

## Check it yourself

```bash
npm ci && npm run reproduce
```

A short run of the same sandbox on a mock model, no keys and no network, about 10 minutes. 7 rounds, 12 agents, 4 orchestrators, with the same traps as in the published runs: an agent gets swapped for a broken one, a descendant starts going bad, the world changes, three agents have no orchestrator. At the end it checks the same claims as the reports and prints MATCH or NO MATCH for each. Rubles on the mock model differ from GigaChat, the conclusions should not.

## Survey of public MCP servers

`npm run mcp-survey` takes remote servers from the open MCP registry, connects once to each and asks for the tool list. Tools are never called. It only counts what can be measured objectively: is the server reachable, does it require auth, can it prove who it is (a DID document on its domain), do tool descriptions show signs of hidden instructions. A repeat survey shows whose descriptions changed without a version bump. The summary contains numbers only, no server names, and there is no safe/unsafe rating.

## Connect your agent

```bash
npm ci
npm test            # unit tests, including the W3C test vector
PUBLIC_URL=http://localhost:4040 ALLOW_PRIVATE_TARGETS=1 ADMIN_TOKEN=dev npm start
```

`ALLOW_PRIVATE_TARGETS=1` allows http and local addresses, **development only**.

```bash
# 1. register (registration or admin key); the response has owner_token and a domain code
curl -X POST $BASE/v1/agents -H "Authorization: Bearer $REG" -H "Content-Type: application/json" \
  -d '{"name":"My agent","mcp_url":"https://agent.example.com/mcp","owner":{"name":"Example Ltd"}}'
# 2. put the code at https://agent.example.com/.well-known/xonta-challenge.txt and confirm
curl -X POST $BASE/v1/agents/$ID/domain-check -H "Authorization: Bearer $OWNER_TOKEN"
# 3. scan the MCP server and test through the gateway
curl -X POST $BASE/v1/agents/$ID/scan -H "Authorization: Bearer $OWNER_TOKEN"
curl -X POST $BASE/v1/agents/$ID/test -H "Authorization: Bearer $OWNER_TOKEN" -d '{"tasks":30}' -H "Content-Type: application/json"
# 4. passport and verification
curl $BASE/v1/agents/$ID/passport
curl -X POST $BASE/v1/verify -H "Content-Type: application/json" -d '{"agent":"'$ID'"}'
```

Calls to the agent then go through the gateway, `POST $BASE/gw/$ID/mcp` (MCP Streamable HTTP), and reputation builds from real traffic.

## Run your own orchestrator

Every orchestrator exposes endpoints so you can look at it before trusting it:

| Endpoint | What it gives you |
|---|---|
| `GET /v1/experience/catalog` | domains, categories and techniques it knows |
| `GET /v1/experience/track-record` | signed track record, including false and missed alarms |
| `POST /v1/experience/query` | signed experience package for chosen categories |
| `GET /v1/experience/evidence/:id` | evidence behind any entry |
| `POST /v1/experience/referral` | where to go with a given task, honestly pointing to a stronger orchestrator |
| `POST /v1/experience/learn` | (admin) learn from another orchestrator: fetch, verify signatures and evidence, keep only what holds up on your own tasks |
| `GET /v1/guardian` | state of descendant supervision |

The full sandbox is in `stand/`. Put a GigaChat key into `stand.env` and start it with one docker compose command (see `stand/README.md`). Orchestrator books live outside the containers and survive rebuilds, so the next run starts with what the orchestrators already know. `stand/AUTOPILOT.md` describes how a server can run experiments and publish results by itself.

## Security and known limits

- Request signing is a simplified scheme (DID, date, method, host, path, body hash, 5 minute window). Replays inside the window are possible. RFC 9421 is planned.
- The MCP scan is heuristic. "Nothing found" doesn't mean "safe". Prompts and resources are not checked yet.
- Outgoing requests are https and public addresses only, no redirects, size limits. DNS rebinding between check and connect isn't fully ruled out.
- One status list of 131 072 credentials, list rotation is planned.
- Events can change until the next daily anchoring.
- Storage is JSON files, fine for one server and a prototype, not for heavy load.
- Owner verification is manual, by an admin under contract. Only an HMAC fingerprint of the owner's id is stored.

## Not there yet

Automatic owner verification against government registries, routing tasks back to the parent when a descendant regresses, a sandbox level for model-based agents, self-hosted licensing, RFC 9421, status list rotation.

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). W3C test vectors in `test/vectors` are under the W3C Software and Document License.

Made by the [Xonta](https://xonta.ru) team.
