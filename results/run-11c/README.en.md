# Run 11c: saving tokens, the third run and what all three add up to

Русская версия: [README.md](README.md)

October 19, 2026, 8 rounds of 40 tickets, GigaChat-2 (small model) and GigaChat-2-Max (large model). Test money and test customers, everything runs in a sandbox.
Code: commit `7dc9e34` (stand 0.14.6, the same as in [run 11](../run-11/README.en.md) and [11b](../run-11b/README.en.md)). The full stand table is in [REPORT.md](REPORT.md) (in Russian).

## What we tested

Same settings as 11b, different 320 tickets (seed `tok-11c`): the orchestrator has no tight large-model budget (`NET_TOK_SENIOR_SHARE=1`), and the check cache lives for 4 rounds (`NET_TOK_CACHE_TTL=4`). The six ways of using the model are described in the [run 11 report](../run-11/README.en.md#what-we-tested). In round 5 fraudsters start writing from the owner's hijacked mailbox; in round 7 the refund window goes from 14 to 30 days.

The main question: in 11b the orchestrator beat "all on Max" by 4.95 ₽ per ticket, but on just four tickets. A real win or a tie?

## Key findings

**The orchestrator is again cheaper than "all on Max", and across two runs the gap is real, but small.** Everything else from run 11 held up for the third time.

| Mode | Correct | Tokens per ticket | Model, ₽ | Handed to a human | Harm over the run, ₽ | With harm, ₽ per ticket |
|---|---|---|---|---|---|---|
| all on Max | 98% | 311 | 0.20 | 32 | 3,600 | 37.45 |
| all on Lite | 80% | 428 | 0.03 | 56 | 12,600 | 76.65 |
| Max on risk | 87% | 502 | 0.11 | 31 | 12,800 | 65.64 |
| digest | 87% | 433 | 0.06 | 31 | 12,800 | 65.59 |
| check cache | 86% | 473 | 0.10 | 31 | 17,700 | 75.07 |
| orchestrator decides | 97% | 487 | 0.17 | 35 | 1,200 | **31.33** |

1. **The orchestrator is 6.19 ₽ per ticket cheaper than "all on Max"** (95% interval 0.09–14.32, nearly touching zero). Over the two runs with identical settings (11b and 11c, 640 tickets) it's 5.57 ₽ (1.51–10.57). Harm was 1,200 ₽ against 3,600 ₽, and 1,000 ₽ of that was shared by every mode. It called Max on 284 of 320 tickets, Max overruled Lite 86 times, nothing went over budget.
2. **The gap comes from the same place in both runs.** In 11c there were three complaints that Max answered on its own when they should have gone to a human (800 ₽ of harm each). Under the orchestrator Lite answered, Max took a second look and handed them to a human (150 ₽). In 11b it was two such complaints plus one going the other way. Two fraud emails in round 7 went opposite ways and cancelled out. So "Lite answers, Max checks" is a bit more careful than Max alone, specifically on complaints. The number depends on how the stand prices a wrong reply to a complaint (800 ₽ against 150 ₽ for a human). Price that mistake differently and the gap may go away.
3. **Max is 39.20 ₽ per ticket cheaper than Lite** (26.85–53.42). Runs 11 and 11b gave 36.86 and 36.39. And again almost all of Lite's harm is a plain reply to a complaint: 10,400 ₽ out of 12,600.
4. **"Max on risk" didn't help, again:** 12,800 ₽ of harm, same as Lite (12,600). It costs 28.19 ₽ more than Max (16.79–41.46) and 34.38 ₽ more than the orchestrator (20.79–48.91). Max was called 125 times, but only for refunds, refusals and hand-offs, never for a plain reply.
5. **The cache did more damage after the rule change than in 11b.** In rounds 7–8 it served the old refund article 69 times. Three times Lite correctly decided to refund under the new 30-day window, and Max, looking at the stale article, turned that into a refusal: 4,500 ₽. In rounds 7–8 the cache saved 480 ₽ on checks and added 4,900 ₽ of harm, 55.21 ₽ per ticket worse than "on risk". In rounds 1–6 it's honestly 5.83 ₽ cheaper.
6. **The digest again halves Max's tokens** (41,400 → 19,200) with the same decisions: two fraud emails flipped in opposite directions, harm came out the same. The difference from "on risk" is −0.05 ₽ per ticket (−1.92…1.83), which this time is just the price of tokens, no lucky break.

Usage: 368,000 tokens (194,000 Lite, 174,000 Max), about 14 minutes.

## All three runs together

With harm, ₽ per ticket:

| Mode | 11 | 11b | 11c |
|---|---|---|---|
| all on Max | 41.36 | 73.39 | 37.45 |
| all on Lite | 78.22 | 109.78 | 76.65 |
| Max on risk | 67.85 | 100.65 | 65.64 |
| digest | 66.54 | 99.97 | 65.59 |
| check cache | 62.10 | 103.98 | 75.07 |
| orchestrator decides | 82.21 (tight budget) | 68.51 | 31.33 |

Paired differences, ₽ per ticket (negative means the first is cheaper). "Pooled" is the mean over all tickets, the interval is a bootstrap over tickets within each run.

| Comparison | 11 | 11b | 11c | Pooled | Verdict |
|---|---|---|---|---|---|
| Lite − Max | 36.86 | 36.39 | 39.20 | 37.48 (30.19…45.34) | Max is cheaper, three out of three |
| on risk − Max | 26.49 | 27.26 | 28.19 | 27.31 (20.23…34.81) | "on risk" costs more, three out of three |
| digest − on risk | −1.31 | −0.67 | −0.05 | −0.67 (−1.72…0.16) | half the Max tokens, no proven saving in money |
| cache − on risk, rounds 7–8 | no stale hits | +30.84 | +55.21 | — | hurts after a rule change, two out of two |
| orchestrator − Max | +40.78 (tight budget) | −4.95 | −6.19 | −5.57 (−10.57…−1.51), 11b and 11c only | slightly cheaper, real but small |

What this means if you run support agents:

- **Save on harm and human time, not on tokens.** Tokens are 0.03–0.2 ₽ per ticket; a wrong reply to a complaint is 800 ₽. The cheapest simple setup is to put everything on the large model.
- **"Large model only on risk" doesn't work if risk means "money".** The most common harm is a plain reply to a complaint that should have gone to a person. You need the second opinion there too.
- **An orchestrator that picks on its own exam where to call the large model is at least as good as the large model alone and a little cheaper**, as long as you don't starve it of budget. On every exam it found that the second opinion pays off on plain replies.
- **Reset a check cache when the article changes, not on a timer.** Otherwise, after a rule change, the large model confidently "fixes" a correct decision into a wrong one.
- **Context digests cost nothing in quality** and cut the large model's tokens in half. At today's prices that's pennies; it starts to matter at roughly 200× pricier tokens.

## If tokens were pricier

Counting harm, the orchestrator stays the cheapest even with expensive tokens: 32.86 ₽ per ticket at ×10 and 48.19 ₽ at ×100, against 39.27 and 57.49 for "all on Max". Its model bill is lower than Max's (0.17 vs 0.20 ₽), so the gap only grows as tokens get pricier. The digest overtakes "all on Max" at about ×200 (≈×190 and ×195 in 11 and 11b). The stand's own "pricier tokens" table in [REPORT.md](REPORT.md) leaves harm out.

## What we expected and what happened

| Expectation from the plan | Result |
|---|---|
| Max cheaper than Lite with harm, not by chance | yes: 39.20 ₽ (26.85–53.42), third time |
| "On risk" costs more than both Max and the orchestrator, interval clear of zero | yes: +28.19 and +34.38 ₽ |
| Orchestrator vs Max: if the interval touches zero, call it a tie | it doesn't, barely: −6.19 (−14.32…−0.09). With 11b, −5.57 (−10.57…−1.51). We say "slightly cheaper", with the caveat about the price of a complaint mistake |
| Nothing over budget | yes |
| Stale cache hits in rounds 7–8, cache costlier than "on risk" there | yes: 69 tickets, +55.21 ₽ per ticket in those rounds |
| About 0.37M tokens, no more than 1.5M | yes: 368,000 |

## Before and after the world changes

With harm, ₽ per ticket:

| Mode | rounds 1–4 | rounds 5–6 | rounds 7–8 |
|---|---|---|---|
| all on Max | 38.39 | 26.20 | 46.83 |
| all on Lite | 65.71 | 81.65 | 93.53 |
| Max on risk | 64.85 | 61.11 | 71.74 |
| check cache | 58.98 | 55.36 | 126.94 |
| orchestrator decides | 34.23 | 26.11 | 30.48 |

In rounds 7–8 Max answered two complaints itself (1,600 ₽) while the orchestrator handed them to a human, hence 46.83 against 30.48. The cache is cheaper than "on risk" before round 7 and twice as expensive after.

## What the orchestrator decided

| Exam before round | Correct: Lite / Max | Call Max on | Value of a second opinion per case |
|---|---|---|---|
| 1 | 83% / 98% | reply, refund, refuse | reply 326 ₽, refund 2,876 ₽ |
| 4 | 88% / 100% | reply, refund, hand-off, refuse | reply 162 ₽, refund 941 ₽ |
| 7 | 73% / 100% | reply, refund, hand-off, refuse | reply 336 ₽, refund 4,671 ₽ |

For the third time in a row the orchestrator worked out by itself that a second opinion pays off on plain replies. Before round 1 it judged hand-offs not worth a second look (6 cases on the exam); after that it called Max on them by default because there were too few cases. The budget was 9,160–9,480 Max tokens per round, it spent about 5,000.

This stand has no experience book and no sub-agents, so there are no sections on newcomers or calibration.

## Orchestrator and stand mistakes

No new mistakes; this stand has no alarms that could go off falsely.

- **The orchestrator's edge over Max depends on what a complaint mistake costs.** Not a bug, but a limit on the conclusion: the whole gap is complaints that the pair handed to a person and Max answered itself. If in real life a wrong reply to a complaint costs less than a person's time, there's no edge.
- **The cache is still naive on purpose.** 69 stale answers and 4,500 ₽ from overruled correct refunds are exactly what it's there to show.
- **The stand's "pricier tokens" table leaves harm out.** The version with harm is above.
- **1,000 ₽ of harm is shared by all six modes** (a complaint in round 1 and an order question in round 3): Max got them wrong too. It doesn't affect the comparison.

## What's next

Three runs close the "saving tokens" topic. Next up is checking the 0.14.7 fixes on the series tickets (run-series1-a2, already running), then a trust history built from the orchestrator's signed log (no run needed) and run 12 on limits across a tree of sub-agents. We didn't add a "cache that resets when the article changes" mode: its result is mostly decided by design.
