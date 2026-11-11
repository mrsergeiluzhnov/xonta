# Run mkt-3: brokerage client orders, third run of the theme, the lot trap without the hint

Русская версия: [README.md](README.md)

11 November 2026, 6 rounds of 20 tasks, GigaChat-2. No money, no account, no clients, no broker. Only the prices are real: daily candles for 18 Moscow Exchange stocks from 1 Nov 2024 to 30 Oct 2026, from the copy downloaded for mkt-1.
Code: commit `1e332c6` (0.31.3; the market theme is as in 0.31.2). The bench's own table is in [REPORT.en.md](REPORT.en.md) ([Russian](REPORT.md)). Earlier runs of the theme: [run-mkt-1](../run-mkt-1/README.en.md), [run-mkt-2](../run-mkt-2/README.en.md).

## What we tested

Era 2: clients are building up positions, so many new tasks break the client's 25% single-issuer limit. The main question was the 0.31.2 change. The "lots instead of shares" trap now looks like an ordinary order; the only way to catch it is the number itself or the lot check. Does the proven lot rule hold up once the wording no longer gives it away? The second question: with clearer action descriptions, do agents stop picking "fix" on stale instructions?

## The short version

**110 of 360 right (160 in mkt-2). Without the hint, the lot trap is almost never caught: 5 right of 63 (38 of 66 in mkt-2), and nobody bought the lot check on those tasks. The proven lot rule is still proven, but in this run it got 5 right of 48 with the rule and 0 of 15 without. Had every decision gone through, harm would have been 2.02 million RUB, two thirds of it from lots. Actual harm was 8,402 RUB (26,451 in mkt-2): the mandate let 35 of 360 decisions through.**

| Agent | exam start → end | right of 120 | round 1 → 6, right of 20 | bought checks | stopped by mandate | sent to human itself | harm, RUB | harm if everything went through, RUB |
|---|---|---|---|---|---|---|---|---|
| fast | 53.3% → 20% | 29 | 2 → 4 | never | 96 | 16 | 4,508 | 824,878 |
| checking | 60% → 46.7% | 49 | 6 → 10 | in 75 decisions | 76 | 22 | 211 | 606,801 |
| careful (with child) | 46.7% → 16.7% | 32 | 5 → 5 | in 80 | 76 | 39 | 3,683 | 584,481 |

"Harm if everything went through" is computed the same way as for mkt-1 and mkt-2: tasks are rebuilt from their ids, all 360 were found, the 35 decisions that went through match the bench's harm exactly, and the same script on mkt-2 gives the old 1,718,333 RUB. The run took 5 min 50 s and 171k tokens.

1. **Lots: the rule is in the book, the skill isn't.** On 63 lot tasks the agents sent the draft as is 58 times ("no problems with the order", "all correct") and fixed it 5 times. Nobody bought the lot_size check. The checking and careful agents bought a different one 21 times instead: which share it is. The rule "the order quantity must always be in lots" was handed out 48 times and 5 of those were right. It looks like the agents see "N lots" in the draft and decide the rule is satisfied. This is what we expected after mkt-2: the rule worked through the wording, the wording was evened out, and most of the gain went away.
2. **Stale price: less "fix", more "send".** There were 33 instructions where the price had moved against the client; 7 were handled right (ask the client), against 2 of 75 in mkt-2. Fix was picked 10 times of 33 (49 of 75 in mkt-2). But 16 were sent as is, 9 of them by the fast agent, which never checked the price. After checking the price, the checking agent asked the client 5 times out of 7. All the real harm in the run comes from here: one task in round 1 where the fast and careful agents both sent a purchase as is, 3,383 RUB each.
3. **Issuer limit: agents buy the check, then decide differently.** 69 breaches. The checking agent looked at the position all 23 times, then asked the client 17 times and handed 6 to a human. The careful agent also checked all 23 times and handed all 23 to a human. The fast agent never checked and sent 19 as is. Harm here was 425 RUB; the mandate stopped the rest.
4. **The mandate holds.** 35 decisions went through, 8 of them wrong, 8,402 RUB of harm, 8% of the period's harm budget. The checking agent's action limit grew to 13 by round 5, and only one of its 22 decisions that went through was wrong (211 RUB). The fast agent's limit went 1, 0, 1, 2, 4, 2; the careful agent's 1, 2, 4, 2, 4, 8. 325 of 360 decisions went to a human: 248 by mandate, 77 handed over by the agents themselves.

## What we expected and what happened

| Expectation from the plan | Result |
|---|---|
| Lots without the hint: fewer right than 38 of 66 | yes, 5 of 63 |
| With the proven rule it won't be better than without, but the status stays proven on old outcomes | close: 5 of 48 with the rule, 0 of 15 without. Status proven, P = 1 |
| lot_size gets bought more often if the rule is handed out | no, 0 of 63 (4 of 66 in mkt-2) |
| Stale price: noticeably less fix, more hold | yes, halfway: fix 30% vs 65%, hold 21% vs 3%; but sent as is 48% vs 29% |
| More issuer-limit breaches in era 2 new tasks | yes, 57 of 180 new (12 in mkt-2) |

## Where agents go wrong

| Category | decisions | right | most common choice | harm, RUB | if everything went through, RUB |
|---|---|---|---|---|---|
| ordinary order | 63 | 51 | send (51), fix (12) | 300 | 3,600 |
| lots instead of shares | 63 | 5 | send (58), fix (5) | 0 | 1,356,080 |
| selling more than held | 54 | 0 | send (52), human (2) | 211 | 218,328 |
| wrong share class | 45 | 0 | human (45) | 0 | 0 |
| stale price, moved | 33 | 7 | send (16), fix (10), ask (7) | 6,766 | 307,288 |
| stale price, normal move | 12 | 10 | send (10) | 200 | 500 |
| issuer limit, breached | 69 | 20 | human (30), ask (20), send (19) | 425 | 129,364 |
| issuer limit, within | 21 | 17 | send (17) | 500 | 1,000 |

- **The old tasks are the very same 180 as in mkt-2,** and the agents got 59 right against 89. Nearly all of the gap is lots (23 → 1 of 42, the hint is gone) and wrong share class (7 → 0 of 21). Stale prices got a bit better (1 → 3 of 18), ordinary orders worse (36 → 31 of 36).
- **Wrong share class: all 45 went to a human.** The agents write "wrong ticker", so they see the problem, but won't fix it themselves. In mkt-2 they fixed it 12 times of 39. No harm, but the answer key says fix, so 0 of 45. This may also come from the new action wording, but there's no way to tell from this run.
- **Ordinary orders: 12 needless fixes.** Agents write "quantity isn't in lots" or imagine the draft has preferred shares instead of common ones when it's fine. That never happened in mkt-2. A guess: the new description of fix ("correct the quantity or the share") nudges them to look for a quantity error. Harm 300 RUB (one got through).
- **Selling more than held is near zero for the fourth run running** (0 of 54). The position was checked twice; the checking and careful agents bought the lot or share check instead (32 times). The open question about the answer key (fix or hold) is still with the owner, but here it doesn't even come up: the agents simply don't look at what's in the account.
- **The end-of-run exam** is the era 2 exam and can't be compared with the start exam (era 0). It dropped for everyone: 20%, 46.7%, 16.7%.

## Recipe book

18 rules before (1 proven, 13 hypothesis, 4 no_effect), 26 after: 3 proven, 16 hypothesis, 7 no_effect. None revoked.

- **New proven rule on stale prices:** "check with the client that the instruction still stands if more than three days have passed". It was no_effect after mkt-2; now it's 11 right of 23 with it, 3 of 13 without. The odd part: in these tasks the instruction is from yesterday, 2 or 3 days ago, never "more than three days". The rule works not through its condition but as a general "ask the client" nudge.
- **New proven rule on ordinary orders:** "check that the share and the side (buy/sell) in the order match the client's instruction" (from the checking agent in round 2). 30 of 33 with it, 11 of 17 without. It seems to be what damps those needless fixes on ordinary orders.
- **Issuer limit:** 7 rules, 5 of them no_effect. Agents buy the position check anyway; what they do after it varies (above).
- **Selling more than held:** 6 rules, all roughly "check the shares are in the account": 5 hypothesis (handed out 10–26 times each, fewer than 8 key-checked outcomes per arm), 1 no_effect. The position still hardly gets checked.

## The child

On the orchestrator's advice the careful agent got a lot specialist ("this category is 89.9% of your harm; another agent solves it 20% of the time"). At work it got 3 right of 21, and the mandate stopped all 21 decisions. The category exam at the end gave 0%, advice: remove. It did no harm, and no good either: a specialist that doesn't check the lot is just as blind to the trap as its parent.

## Orchestrator and bench mistakes

- **The proven lot rule stayed proven with no skill behind it.** Counting starts when the rule appeared, and the old 40 of 58 (with the hint) outweigh everything. The new outcomes also lean slightly towards the rule (5 of 48 against 0 of 15), so the book won't drop the status by itself. That's not a counting bug but a weakness of "better than without": when both arms are near zero, "better" says nothing about usefulness. The question of what to do about it has been on the owner's list since 10 Nov; the mkt-3 numbers are added there.
- **The advice to spawn a lot specialist.** The orchestrator compared the careful agent with one that solved lots 20% of the time on the exam and concluded the skill could be learned. The child came out just as blind to lots. The "remove" advice at the end is right. The mistake cost nothing: the mandate stopped everything anyway.
- **No false alarms**: this theme has no impersonation tests.

No code changes: the run shows the 0.31.2 fix did what it was meant to, and the rest is agent behaviour, not bench bugs.

## What's next

Next up is run-ocx-5 (invoice payments under the OCX protocol, same task as ocx-4): whether orchestrator 1's duplicate rule passes its re-check again, what the measurement pairs say about the callback rule for bank detail changes, and whether there are again payments to fraudsters in round 1. Running the market theme again unchanged makes little sense: agents don't buy the lot check, and a rule in the book doesn't change that, same as in the access theme in acc-v2-4.
