# A metered lookup on a list that doesn't fit

Русская версия: [README.md](README.md)

October 19, 2026. No model and no live API, this is a quick deterministic calculation over 500 seeds. Script `stand/lookup-scenario.js`, run it with `npm run lookup-scenario`. Updated in 0.17 with the orchestrator's rule, a borderline list and an agent that inflates its numbers.

## Where the numbers come from

Kevin Hall published a trace of one morning on a metered phone lookup ([dev.to, October 16](https://dev.to/kevinhall/what-a-metered-data-api-sees-when-an-agent-runs-it-unattended-103-parallel-runs-35342-rate-limit-1d85)). A buyer's agent ran 103 runs of about 1,000 profiles each, unattended. A number was found for 1,021 of 79,625 answered rows, 1.28%. Fitting lists that same week gave 14 to 26%, and a list three days earlier gave 257 of 1,000. That earlier result was the "exam", and it said nothing about this list. Only these shares are used here, no rows and no personal data.

## Three rules

- **Budget cap.** The agent launches the whole list and stops when it has paid for 5,000 numbers, what the 25% "exam" promised on 20,000 rows. This is what happened that morning.
- **100-row probe**, the author's rule. A seeded random sample of 100 rows from the whole list. Under 5% found means stop and ask a human, otherwise the rest runs at once.
- **Xonta.** The agent launches in batches. The first batch is 100 rows and every clean batch doubles the next one, up to 5,000. Every 100 rows the last 300 are checked. If the found share is significantly below the owner's floor (the same 5%, binomial test, p < 0.01) the limit goes to zero and a human is asked. A batch already launched runs to the end, and that counts as loss.

## Results

| Scenario | Rule | Rows run | Numbers found | Rows on the unfitting list | Stopped, % | Rows until stop (median / 95%) | Questions to a human |
|---|---|---|---|---|---|---|---|
| the morning: the whole list doesn't fit | budget cap | 103 000 | 1 319 | 103 000 | 0 | — | 0 |
| the morning: the whole list doesn't fit | 100-row probe | 1 336 | 17 | 1 335 | 98.8 | 100 / 100 | 1 |
| the morning: the whole list doesn't fit | batches checked as they run (0.16.2) | 286 | 4 | 286 | 100 | 200 / 400 | 1 |
| the morning: the whole list doesn't fit | 0.17 job, self-report + checker | 1 000 | 13 | 1 000 | 100 | 100 / 300 | 1.1 |
| the morning: the whole list doesn't fit | 0.17 job, through the gateway | 132 | 2 | 132 | 100 | 100 / 300 | 1.1 |
| a fitting list, 20% | budget cap | 24 987 | 5 000 | 0 | 0 | — | 0 |
| a fitting list, 20% | 100-row probe | 103 100 | 20 596 | 0 | 0 | — | 1 |
| a fitting list, 20% | batches checked as they run (0.16.2) | 103 000 | 20 596 | 0 | 0 | — | 0 |
| a fitting list, 20% | 0.17 job, self-report + checker | 103 000 | 20 596 | 0 | 0 | — | 0 |
| a fitting list, 20% | 0.17 job, through the gateway | 103 000 | 20 596 | 0 | 0 | — | 0 |
| a fitting list, 14% (low end of that week) | budget cap | 35 736 | 5 000 | 0 | 0 | — | 0 |
| a fitting list, 14% (low end of that week) | 100-row probe | 103 100 | 14 420 | 0 | 0 | — | 1 |
| a fitting list, 14% (low end of that week) | batches checked as they run (0.16.2) | 103 000 | 14 420 | 0 | 0 | — | 0 |
| a fitting list, 14% (low end of that week) | 0.17 job, self-report + checker | 103 000 | 14 420 | 0 | 0 | — | 0.7 |
| a fitting list, 14% (low end of that week) | 0.17 job, through the gateway | 103 000 | 14 420 | 0 | 0 | — | 0.7 |
| spliced list: 30k fit at 20%, then 73k at 1.28% | budget cap | 24 997 | 5 000 | 0 | 0 | — | 0 |
| spliced list: 30k fit at 20%, then 73k at 1.28% | 100-row probe | 84 766 | 5 702 | 60 006 | 17.8 | — | 1 |
| spliced list: 30k fit at 20%, then 73k at 1.28% | batches checked as they run (0.16.2) | 31 300 | 6 017 | 1 300 | 100 | 300 / 500 | 1 |
| spliced list: 30k fit at 20%, then 73k at 1.28% | 0.17 job, self-report + checker | 31 098 | 6 015 | 1 098 | 100 | 300 / 400 | 2 |
| spliced list: 30k fit at 20%, then 73k at 1.28% | 0.17 job, through the gateway | 30 403 | 6 006 | 403 | 100 | 300 / 400 | 2 |
| a borderline list, 6% (floor 5%) | budget cap | 83 366 | 5 000 | 0 | 0 | — | 0 |
| a borderline list, 6% (floor 5%) | 100-row probe | 73 230 | 4 390 | 0 | 29 | 100 / 100 | 1 |
| a borderline list, 6% (floor 5%) | batches checked as they run (0.16.2) | 75 924 | 4 555 | 0 | 50.6 | 45 300 / 95 900 | 0.5 |
| a borderline list, 6% (floor 5%) | 0.17 job, self-report + checker | 95 248 | 5 714 | 0 | 7.6 | 100 / 200 | 1 |
| a borderline list, 6% (floor 5%) | 0.17 job, through the gateway | 95 182 | 5 710 | 0 | 7.6 | 100 / 200 | 1 |
| the agent inflates: 1.28% real, ~6% claimed | budget cap | 84 162 | 1 080 | 84 162 | 0 | — | 0 |
| the agent inflates: 1.28% real, ~6% claimed | 100-row probe | 75 290 | 965 | 75 217 | 27 | 100 / 100 | 1 |
| the agent inflates: 1.28% real, ~6% claimed | batches checked as they run (0.16.2) | 71 420 | 918 | 71 420 | 56 | 42 800 / 93 900 | 0.6 |
| the agent inflates: 1.28% real, ~6% claimed | 0.17 job, self-report + checker | 1 000 | 13 | 1 000 | 100 | 100 / 300 | 1.3 |
| the agent inflates: 1.28% real, ~6% claimed | 0.17 job, through the gateway | 128 | 2 | 128 | 100 | 100 / 300 | 1.2 |

## What this shows

1. **On that morning both the probe and Xonta stop almost right away.** The probe is a bit faster, at 100 rows against a median of 200 for Xonta. But in 1.2% of seeds the probe drew 5 or more hits by chance and launched the whole list. Xonta never ran on. The budget cap ran all 103,000 rows, like in the real trace.
2. **On fitting lists neither rule stopped by mistake**, in 500 seeds at 20% and 500 at 14%.
3. **The spliced list is where they differ.** The first 30,000 rows fit at 20% and the other 73,000 don't. The average over the whole list is 6.7%, above the floor. The probe let it through 82% of the time and spent on average 60,000 rows on the part that doesn't fit. In the other 18% it stopped at once and lost the good part too. Xonta stopped every time, with a median of 300 rows after the list went bad. A check done once at the start judges the average. A check that keeps running sees the moment things change.
4. **The cost of the Xonta way is the batch already in flight.** On the spliced list it ran 1,300 rows past the switch on average, because a batch of up to 5,000 had already been launched. A smaller top batch means less loss and more frequent launches.
5. **The budget cap only looks good when the cap happens to land inside the fitting part.** That's what happened on the spliced list. On that morning it let everything run.

## 0.17: the same rule inside the orchestrator, a job with a forecast and a question to the owner

After the conversation with the author of the trace the rule moved into the orchestrator itself (`src/jobs.js`, "jobs"). The agent declares the size, what counts as a success, the floor and the price, and the owner confirms. Every 100 rows the orchestrator works out the success rate and a forecast for the rest as a range, how many successes, how much money and how many hours. If the rate is under the floor it advises asking the user and suspends the job's mandate. The user's answer is a new mandate with bounds, and the next question comes only when they are crossed. The bound is checked over all rows since the decision, not over one window. The scenario has two variants.

- **Through the gateway.** Every call goes through the orchestrator, the gateway counts successes from the tool's answer and an alarm stops at once.
- **Self-report and a checker.** The agent reports in batches of up to 1,000 rows. After each hundred the orchestrator picks 10 rows and an independent checker re-runs them (it fails to confirm 5% of rows because of stale data even when the agent is honest).

The human in the scenario is an assumption. They see the forecast and stop the job if the rate since their last decision is under 3% or the checker didn't confirm what was claimed. Two scenarios were added, a borderline list (6% with a 5% floor) and an agent that inflates its numbers (1.28% real, about 6% claimed).

**What came out.**
1. **That morning.** Through the gateway the job stops at row 100 (132 rows on average, sometimes the first 100 reach 5% by chance). With self-report the batch already launched runs to the end, 1,000 rows. That's the price of the batch, so the gateway is better.
2. **Fitting lists (20% and 14%)** were never stopped, 0 to 0.7 questions per run on average.
3. **The spliced list.** It stops 300 rows after the switch (400 at the 95th percentile), with two questions per run. On the first the human sees that things went well so far and continues, on the second that the rate fell after their decision, and stops.
4. **The borderline list.** One question per run, stopped in 7.6% of runs, almost all at row 100 when the first 100 rows happened to give 2% or less. The author's probe stopped such a list 29% of the time, the 0.16.2 rule 51%.
5. **The inflating agent.** The earlier rules trust the claimed 6% and let the list through in 44 to 100% of runs. The 0.17 job always catches it. Through the gateway the gateway sees the truth itself, with self-report the checker doesn't confirm the claimed successes in the first hundred (median 100 rows).
6. **The first version of the check gave false signals.** There are many checks, one after every hundred, and with a significance level of 0.01 an honest agent on a fitting list got a "not confirmed" signal in a quarter of runs. The threshold is now stricter (0.0001 for one sample, 0.001 for the sum of all samples of the job), and there are no false signals in 1,000 runs on fitting lists. Slow inflation shows up in the sum.

## Limits

This is a model of the shares, not a replay of real rows. It ignores rate limits and retries (35,342 refusals that morning) and the time cost. The Xonta parameters (window 300, check every 100, p < 0.01, top batch 5,000) were picked by hand and not tuned. The floor of 5% is the author's and is the same for both rules.
