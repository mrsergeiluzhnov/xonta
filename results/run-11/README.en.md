# Run 11: saving tokens

Русская версия: [README.md](README.md)

October 19, 2026, 8 rounds of 40 tickets, GigaChat-2 (small model) and GigaChat-2-Max (large model). Test money and test customers, everything runs in a sandbox.
Code: commit `630672f` (stand 0.14.6). The full stand table is in [REPORT.md](REPORT.md).

## What we tested

The same 320 tickets went through six ways of using the model. Checkers, company rules and the ruble scoring are identical for all of them. The only difference is which model decides and when the large one gets called:

- **all on Max** — GigaChat-2-Max decides everything;
- **all on Lite** — GigaChat-2 decides everything;
- **Max on risk** — the small model decides, and the large one is called when the small one wants to refund, refuse or hand off to a human;
- **digest** — same as above, but the large model gets a short digest instead of the full context;
- **check cache** — same as "Max on risk", but repeat knowledge-base checks come from a cache that lives 2 rounds;
- **orchestrator decides** — on its exam it measures where a second opinion from the large model pays for itself and calls it only there. The large model has a token budget per round; once it runs out, money decisions go to a human.

A ticket's cost is tokens at the tariff (65 ₽ and 650 ₽ per 1M), paid checks, 150 ₽ per human handoff, and harm: wrong refunds, money sent to fraudsters, leaked data. In round 5 fraudsters start writing from the owner's hacked mailbox, and in round 7 the refund window changes from 14 to 30 days.

## The short version

**Counting harm, running everything on the large model is the cheapest option.** Tokens barely matter here: 0.2 ₽ per ticket for Max, against 15.6 ₽ of harm and 14.5 ₽ of human time. The thing to save is harm and people's time, not tokens.

| Mode | Correct | Tokens per ticket | Model, ₽ | Handoffs | Harm over the run, ₽ | With harm, ₽ per ticket |
|---|---|---|---|---|---|---|
| all on Max | 98% | 316 | 0.21 | 31 | 5 000 | **41.36** |
| all on Lite | 81% | 450 | 0.03 | 54 | 13 400 | 78.22 |
| Max on risk | 87% | 543 | 0.13 | 29 | 13 800 | 67.85 |
| digest | 88% | 459 | 0.08 | 29 | 13 400 | 66.54 |
| check cache | 87% | 543 | 0.13 | 29 | 13 800 | 62.10 |
| orchestrator decides | 74% | 448 | 0.12 | 85 | 10 000 | 82.21 |

1. **The large model is 36.86 ₽ per ticket cheaper than the small one** (95% interval 24.98–49.67), even though its tokens cost 10 times more. It did 5 000 ₽ of harm against 13 400, and handed off 31 tickets against 54. The small model also burns more tokens: the checker sent its decisions back for a redo 90 times, the large model's — never.
2. **Calling Max "on risk" didn't reduce harm.** It was called 155 times, fixed 21 decisions and didn't break a single correct one. But 10 200 ₽ of the small model's 13 400 ₽ of harm came from plain replies: answering a complaint that should have gone to a human (8 000 ₽), and answering a vague ticket where it should have asked what's wrong (2 200 ₽). A plain reply never triggers the large model. What it did help with is handoffs: 29 instead of 54. Still 26.49 ₽ per ticket more expensive than all on Max (14.93–39.76).
3. **The orchestrator found the right place for the large model, then ran out of budget.** On all three exams it saw that a second opinion pays off on plain replies (52–598 ₽ per case), exactly where "on risk" never calls it. Its harm is the lowest of all the small-model modes, 10 000 ₽. But the budget was 30% of tickets, which is 12 large-model calls per round, and it ran dry mid-round. After that 42 money decisions went to a human, and in 33 of them the small model would have been right. 85 handoffs is where its bad price comes from. This is a stand setting, not the orchestrator's choice: the budget has nothing to do with how many calls its own policy needs.
4. **The digest halves the large model's tokens** (52 000 → 24 900; per ticket 543 → 459) with the same quality. On one fraud ticket it even helped, minus 400 ₽ of harm. Saving is 1.31 ₽ per ticket (0.05–3.18), almost all of it from that one case; on tokens alone it's 0.05 ₽.
5. **The check cache saves half of the paid checks**, 5.75 ₽ per ticket, 920 checks served from cache. It returned nothing stale, but **this run didn't test the danger of caching**: the cache lives 2 rounds and refreshed in rounds 1, 3, 5, 7, which is exactly the round the rules changed. On the mock model with a 4-round cache, stale answers show up in 59 tickets and harm goes up.

## If tokens were more expensive

If the same tokens cost 10 or 100 times more (other providers' models), all on Max is still the cheapest once harm is counted: 43.21 ₽ at ×10 and 61.68 ₽ at ×100, against 63.27 and 74.00 for the best small-model modes. The digest only overtakes it at around ×190 (at ×200: 81.54 vs 82.20 ₽). The stand's own "If tokens were more expensive" table in [REPORT.md](REPORT.md) leaves harm out, so it tells a different story: there Max loses already at ×100.

## What we expected and what we got

| Expectation from the plan | Result |
|---|---|
| The run finishes within 1.5M tokens | yes: 8 of 8 rounds in 13 minutes, 339 000 tokens (177 000 small, 162 000 large). Identical model requests run once, so it was faster and cheaper than estimated |
| Per mode: tokens and rubles per correct answer, harm, handoffs | yes, table above and in REPORT.md. This stand has no descendants; the large model's share of tokens ranges from 9% (orchestrator) to 30% |
| What is cheapest counting harm | all on Max, and the gap to every other mode is not random |
| Cache after the rule change in round 7 | not tested: the cache refreshed exactly in round 7 |
| Recount at ×10 and ×100 | Max is still cheaper at ×100 once harm is counted |

## Before and after the world changes

| Mode | rounds 1–4 | rounds 5–6 | rounds 7–8 |
|---|---|---|---|
| all on Max | 98% | 95% | 100% |
| all on Lite | 86% | 73% | 78% |
| Max on risk | 87% | 84% | 91% |
| orchestrator decides | 79% | 78% | 63% |

The large model holds up through both changes. The small one is worst in rounds 5–6 (fraud from hacked mailboxes). The orchestrator drops to 63% in rounds 7–8: after the exam before round 7 it called the large model on replies, refunds, refusals and handoffs, the budget ran out faster, and 23 money decisions went to a human.

## Mistakes by the orchestrator and the stand

- **The large model's budget isn't tied to the orchestrator's policy.** The budget is 30% of tickets (`NET_TOK_SENIOR_SHARE=0.3`), while the exam says the large model is needed in 50–95% of cases. Over budget, a refund goes to a human: 42 extra handoffs at 150 ₽. Fix without touching code: the repeat runs with a 100% budget, so we see what the policy itself costs.
- **Cache refresh and the rule change landed on the same round.** Cache entries appeared in round 1 and refreshed every 2 rounds, and the refund window changed in a refresh round. Fix: the repeat uses a 4-round cache, so entries from round 5 live into rounds 7–8. Checked on the mock model: 59 stale answers.
- **"Call Max on risk" looks in the wrong place.** Not a stand bug but a finding: the costliest harm comes from a plain reply, not from a refund or a refusal. The orchestrator worked that out on its own exam.

## Next

A repeat, run-11b, on different tickets (seed `tok-11b`), with a 100% large-model budget and a 4-round cache. Three questions: does "all on Max is cheaper" hold on other tickets, what does the orchestrator's policy cost without a budget squeeze, and how much harm does the cache cause after the rules change.
