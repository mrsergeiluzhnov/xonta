# A cap on a single action

Русская версия: [README.md](README.md)

October 19, 2026, version 0.17.1. A short sandbox run on the mock model (`npm run reproduce`, 7 rounds, 12 agents, 4 orchestrators), twice on the same tickets, with the cap and without it (`SUP_PER_ACTION_SHARE=0`). Mock model numbers, not GigaChat.

## Why

A reader on dev.to pointed out that a limit of "harm budget ÷ average harm per action" assumes harm is spread out. In support it has a heavy tail. Most mistakes cost 50 to 200 rubles, and a refund to a fraudster costs the order plus 3,000 for the leaked data. The agent had a limit on the number of actions and on the total of refunds per period, but none on a single operation. With 60,000 rubles of refunds left, one 9,000 refund to a fraudster went through. Smart wallets give a session key two limits for this, one per period and one per transaction.

## What changed

- **A cap on a single action in the mandate** (`max_refund_per_action_rub`). A larger refund always goes to a human, however much is left in the period. By default it's the whole harm budget of the period (2,000 rubles), so one operation can't use it all up alone. `SUP_MAX_PER_ACTION` sets an amount, `SUP_PER_ACTION_SHARE=0` turns it off.
- **The gateway checks both limits**, and every operation's log entry records the cap it passed under.
- **Bring-your-own field exams** (the public orchestrator) compute the limit from the upper bound of the average harm (mean + 1.645·σ/√n) instead of the average, and the mandate carries `max_harm_per_action`. With the same average harm of $1 per action, an agent with even mistakes gets 20 actions and an agent with one $40 mistake gets 8.
- **A large refund stopped by the cap counts as a large case for the alarm** when the agent has also stopped calling its team. More on that below.

## Results

| | Without the cap | With the cap |
|---|---|---|
| Harm by the swapped agent in the swap round | 19,440 rubles (one refund to a fraudster and one leak) | **0** (2 large refunds went to a human) |
| Actions left to the swapped agent after the alarm | 0 | 0 |
| Harm by all supervised agents over the run | 44,410 | **10,870** |
| Gain of all supervised agents | 225,430 | **250,970** |
| Refunds to fraudsters | 2 | **0** |
| Handoffs to a human | 726 | 779 (+53; 105 refunds went over the cap) |
| `npm run reproduce` | 9 of 9 | **10 of 10** |

The cap costs extra handoffs, refunds above 2,000 rubles are now a human's call. In this run it paid off, a quarter of the harm and 25,540 rubles more gain.

## What turned up on the way

With the cap but without the last change, reproduce didn't match. After the alarm the swapped agent kept 3 actions instead of 0 and did another 1,500 rubles of harm. The cap had hidden the evidence. A severe alarm (zero actions) is raised when the agent stops calling its checkers and makes a large mistake. The swapped agent tried to refund a fraudster, the gateway refused, there was no harm, and the alarm came out mild. Now a large refund stopped by the cap counts as a large case, but only together with skipping the team. An honest agent with its checkers doesn't get an alarm that way.

## Limits

This is the mock model and one set of tickets. The GigaChat check is a repeat of the series on the same tickets, the next run after run-series1-a3. The default cap (the whole period budget) follows the reader's argument and wasn't tuned.
