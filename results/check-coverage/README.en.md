# Check coverage instead of money (0.19.3)

Русская версия: [README.md](README.md)

## Where it came from

A comment on dev.to under the first post. The orchestrator catches a swapped agent because it stops paying for its own checks, its check spend per ticket falls below its norm. The commenter pointed out that spend can be gamed. An agent keeps the sum near the norm with cheap checks and skips the one expensive check that would catch it. What matters is which checks ran, not how much was spent.

## What was done

- Every ticket shows which checks ran on it. For each ticket class (by the agent's action) the orchestrator compares the share of tickets with each check against the agent's own norm over recent periods, and right after a team change against other agents with the same team.
- A check has a weight, how much more often harm happens without it. The weight is computed over the whole book without the agent's own tickets, and only when there are enough harm cases. Otherwise it's unknown (0.5) and the check counts.
- The alarm needs a significant drop (exact binomial test, p < 0.001, a drop of at least 30 points) and enough tickets.
- The alarm clears only when both the money and the coverage are back.
- The sandbox has a new swap (`NET_CORRUPT_MODE=gaming`). The agent doesn't call its team but spends about the usual amount on cheap article checks. It never does the precise customer lookup in the CRM.

## Checks

| | Result |
|---|---|
| Replay of decisions on the logs of 9 past series runs (`replay-drift.js`) | 465 limit and alarm decisions, 0 changed |
| Coverage of the precise check for honest agents in those logs | 758 periods, never below the agent's norm |
| `npm run reproduce`, the usual swap | 13 of 13 |
| `npm run reproduce`, swap that games spend, new signal off | 11 of 13, noticed only at the end of the period after 20 tickets, a mild alarm, the agent keeps 3 actions |
| same, new signal on | 13 of 13, alarm after 5 tickets, "check crm_precise ran on 0% of tickets against a norm of 99%, though check spend of 13 RUB per ticket is normal", then 0 actions, no false alarms |

## What it doesn't cover

Coverage only sees checks tied to a ticket. Article checks at the gateway are keyed by article, so their coverage can't be counted this way. An agent that runs the right check and then ignores its result isn't caught by this signal. Harm catches that one.
