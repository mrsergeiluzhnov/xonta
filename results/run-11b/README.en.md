# Run 11b: saving tokens, the repeat

Русская версия: [README.md](README.md)

October 19, 2026, 8 rounds of 40 tickets, GigaChat-2 (small model) and GigaChat-2-Max (large model). Test money and test customers, everything runs in a sandbox.
Code: commit `d9052b2` (stand 0.14.6, the same as in [run 11](../run-11/README.en.md)). The full stand table is in [REPORT.md](REPORT.md).

## What we tested

Same stand as run 11: the same tickets go through six ways of using the model (all on Max, all on Lite, Max on risk, digest, check cache, orchestrator decides). The modes and the pricing are described in the [run 11 report](../run-11/README.en.md#what-we-tested).

What changed since run 11:

- **a different set of 320 tickets** (seed `tok-11b`), to see whether the result holds;
- **the orchestrator no longer has a tight large-model budget** (`NET_TOK_SENIOR_SHARE=1`). In run 11 the budget ran dry mid-round and money decisions went to a human (bug 25);
- **the check cache lives 4 rounds** (`NET_TOK_CACHE_TTL=4`). In run 11 it happened to refresh exactly in the round the rules changed, so it never served anything stale (bug 26).

As before, in round 5 fraudsters start writing from the owner's hacked mailbox, and in round 7 the refund window goes from 14 to 30 days and the refund article is updated.

## The short version

**Without a tight budget, the orchestrator caught up with "all on Max" and even edged past it.** The main result of run 11 mostly holds: counting harm, the large model is far cheaper than the small one, and calling it "on risk" barely reduces harm. The cache turned out to be dangerous after a rule change, as expected.

| Mode | Correct | Tokens per ticket | Model, ₽ | Handoffs | Harm over the run, ₽ | With harm, ₽ per ticket |
|---|---|---|---|---|---|---|
| all on Max | 98% | 314 | 0.20 | 34 | 14 800 | 73.39 |
| all on Lite | 81% | 431 | 0.03 | 50 | 24 100 | 109.78 |
| Max on risk | 87% | 516 | 0.12 | 29 | 24 300 | 100.65 |
| digest | 88% | 440 | 0.07 | 29 | 24 100 | 99.97 |
| check cache | 86% | 492 | 0.11 | 28 | 27 400 | 103.98 |
| orchestrator decides | 95% | 477 | 0.16 | 35 | 13 100 | **68.51** |

There's more harm across the board this time because the tickets are different. 12 800 ₽ of it is the same for all six modes: one refund that shouldn't have happened (8 300 ₽, round 6) and three refusals of a refund the customer was entitled to (1 500 ₽ each, rounds 5 and 7). The large model got those wrong too. The run's data doesn't tell us why. These four tickets don't affect the comparison, since every mode has them.

1. **The orchestrator is 4.95 ₽ per ticket cheaper than all on Max, but the margin is thin** (95% interval 0.26–11.83). It called the large model on 263 of 320 tickets, and 82 times the large model changed the small one's decision. Zero decisions over budget, 35 handoffs (34 for all on Max). The whole gap comes down to four tickets: two complaints that Max answered by itself (800 ₽ of harm each), while in the orchestrator's setup the small model answered, the large one took a second look and handed it to a human; one fraud email that Max replied to (200 ₽) and the pair refused; and one complaint going the other way (−100 ₽). It looks like two models where one checks the other make slightly fewer mistakes than the large model alone, but four tickets don't prove it.
2. **The large model is still far cheaper than the small one:** by 36.39 ₽ per ticket (23.42–49.67). Run 11 had 36.86, nearly the same on completely different tickets. And again, the most expensive thing the small model does is reply to a complaint that should have gone to a human: 10 500 ₽ out of 24 100.
3. **"Max on risk" again didn't reduce harm**: 24 300 ₽ against 24 100 for the small model alone. It was called 137 times and changed 45 decisions, but a plain reply never triggers it. It's 27.26 ₽ more expensive than all on Max (14.14–41.15) and 32.21 ₽ more than the orchestrator (18.61–47.05). The orchestrator also called the large model on plain replies (151 times), and that's the difference.
4. **The cache does harm after a rule change.** In rounds 7–8 it served the old refund article 59 times, exactly as on the mock model. The clearest case is round 8: twice the small model correctly decided to refund under the new 30-day window, and the large model, reading the old article from the cache, overruled it into a refusal. That's 3 000 ₽ of harm. In rounds 7–8 the cache saved 480 ₽ on checks and added 3 100 ₽ of harm, 30.84 ₽ per ticket more counting harm. Over the whole run the gap to "Max on risk" is +3.33 ₽ and could be noise (−8.13 to +19.60), because in rounds 1–6 the cache does save money honestly. The takeaway: a check cache is only safe if it's invalidated when the article changes, not on a timer.
5. **The digest again halves the large model's tokens** (45 500 → 21 100) with no loss in quality. It saves 0.67 ₽ per ticket (0.04–1.93), and once more almost all of it comes from one fraud ticket where the digest version didn't make the mistake.

## If tokens were more expensive

Counting harm, the orchestrator stays the cheapest even with expensive tokens: 69.98 ₽ per ticket at ×10 and 84.65 ₽ at ×100, against 75.23 and 93.59 for all on Max. The digest only overtakes all on Max at around ×195, about where it did in run 11 (≈190). The stand's "If tokens were more expensive" table in [REPORT.md](REPORT.md) leaves harm out.

## What we expected and what we got

| Expectation from the plan | Result |
|---|---|
| All on Max is the cheapest counting harm, and the gap to "on risk" and to Lite is not random | partly: against Lite (36.39 ₽) and "on risk" (27.26 ₽), yes. But the orchestrator without a tight budget beats all on Max by 4.95 ₽, with the interval almost touching zero |
| Orchestrator: no more handoffs than "on risk" (29), zero over budget | zero over budget, yes. 35 handoffs, more than "on risk" and about the same as all on Max (34): the pair sends complaints to a human the way the large model does |
| Orchestrator harm below "on risk" | yes: 13 100 ₽ against 24 300 ₽, lower even than all on Max (14 800 ₽) |
| 4-round cache: stale answers in rounds 7–8 and what they cost | yes: 59 tickets, +3 100 ₽ of harm against 480 ₽ saved on checks in those rounds |
| At most 1.5M tokens | yes: 367 000 tokens (192 000 small, 175 000 large), 14.5 minutes |

## Before and after the world changes

With harm, ₽ per ticket:

| Mode | rounds 1–4 | rounds 5–6 | rounds 7–8 |
|---|---|---|---|
| all on Max | 32.14 | 149.96 | 79.33 |
| all on Lite | 68.53 | 177.28 | 124.78 |
| Max on risk | 66.74 | 157.39 | 111.73 |
| check cache | 60.86 | 151.64 | 142.57 |
| orchestrator decides | 27.97 | 146.72 | 71.10 |

Rounds 5–6 are expensive for everyone because of the one 8 300 ₽ refund all six modes made. The cache is cheaper than "on risk" in rounds 1–6 and clearly more expensive in rounds 7–8. The orchestrator is the cheapest in all three stretches, though in rounds 5–6 its lead over all on Max is small (146.72 vs 149.96 ₽).

## The orchestrator's decisions

| Exam before round | Correct: Lite / Max | Calls Max on | Gain from a second opinion, per case |
|---|---|---|---|
| 1 | 70% / 100% | reply, refund, handoff | reply 267 ₽, refund 3 490 ₽ |
| 4 | 65% / 100% | reply, refund, handoff | reply 727 ₽, refund 5 304 ₽ |
| 7 | 65% / 100% | reply, refund, handoff, refusal | reply 42 ₽, refund 9 568 ₽ |

Same as in run 11, on every exam the orchestrator found by itself that a second opinion pays off on plain replies. Handoffs and refusals fall under "too few cases, call by default". In rounds 1–6 it didn't call the large model on refusals ("doesn't pay off"), but that cost nothing here: on the three refusals everyone got wrong, the large model got them wrong too. The budget was 9 240–9 680 large-model tokens per round and it used about 4 500, so the budget no longer got in the way.

This stand has no experience book and no descendants, so the sections on newcomers and calibration don't apply here.

## Orchestrator and stand bugs

- **Bug 25 (large-model budget unrelated to the orchestrator's policy): confirmed it was the setting.** With a 100% budget there are zero decisions over budget, 95% correct instead of 74%, and the price is 68.51 ₽ instead of the worst of the lot. No code changes. What it means in practice: a budget for second opinions should be derived from the policy, not set as a share of tickets.
- **Bug 26 (the cache refreshed exactly in the rule-change round): now we can see the danger.** 59 stale answers in rounds 7–8, 3 100 ₽ of extra harm, 3 000 ₽ of it from the large model overruling a correct refund based on the old article. The stand works as intended: the cache here is deliberately naive.
- **A second opinion based on stale data is worse than none.** That's a finding, not a stand bug: the large model trusts what it's given and confidently "fixes" a correct decision into a wrong one.
- **The stand's "If tokens were more expensive" table still leaves harm out.** The recalculation with harm is above, under "If tokens were more expensive".

## What's next

A third run with the same settings on different tickets (run-11c, seed `tok-11c`). The orchestrator's win over all on Max rests on four tickets and one run, so we need another one to see whether it's real or just a tie. After that: the trust history in the per-agent report (no run needed) and run 12 on limits across a tree of descendants.
