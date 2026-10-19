# A metered lookup on a list that doesn't fit

Русская версия: [README.md](README.md)

October 19, 2026. No model and no live API, this is a quick deterministic calculation over 500 seeds. Script `stand/lookup-scenario.js`, run it with `npm run lookup-scenario`.

## Where the numbers come from

Kevin Hall published a trace of one morning on a metered phone lookup ([dev.to, October 16](https://dev.to/kevinhall/what-a-metered-data-api-sees-when-an-agent-runs-it-unattended-103-parallel-runs-35342-rate-limit-1d85)). A buyer's agent ran 103 runs of about 1,000 profiles each, unattended. A number was found for 1,021 of 79,625 answered rows, 1.28%. Fitting lists that same week gave 14 to 26%, and a list three days earlier gave 257 of 1,000. That earlier result was the "exam", and it said nothing about this list. Only these shares are used here, no rows and no personal data.

## Three rules

- **Budget cap.** The agent launches the whole list and stops when it has paid for 5,000 numbers, what the 25% "exam" promised on 20,000 rows. This is what happened that morning.
- **100-row probe**, the author's rule. A seeded random sample of 100 rows from the whole list. Under 5% found means stop and ask a human, otherwise the rest runs at once.
- **Xonta.** The agent launches in batches. The first batch is 100 rows and every clean batch doubles the next one, up to 5,000. Every 100 rows the last 300 are checked. If the found share is significantly below the owner's floor (the same 5%, binomial test, p < 0.01) the limit goes to zero and a human is asked. A batch already launched runs to the end, and that counts as loss.

## Results

| Scenario | Rule | Rows run | Numbers found | Rows on the unfitting list | Stopped, % | Rows until stop (median / 95%) |
|---|---|---|---|---|---|---|
| the morning: the whole list doesn't fit | budget cap | 103 000 | 1 319 | 103 000 | 0 | — |
| the morning: the whole list doesn't fit | 100-row probe | 1 336 | 17 | 1 335 | 98.8 | 100 / 100 |
| the morning: the whole list doesn't fit | Xonta: batches, checked as it runs | 286 | 4 | 286 | 100 | 200 / 400 |
| a fitting list, 20% | budget cap | 24 987 | 5 000 | 0 | 0 | — |
| a fitting list, 20% | 100-row probe | 103 100 | 20 596 | 0 | 0 | — |
| a fitting list, 20% | Xonta: batches, checked as it runs | 103 000 | 20 596 | 0 | 0 | — |
| a fitting list, 14% (low end of that week) | budget cap | 35 736 | 5 000 | 0 | 0 | — |
| a fitting list, 14% (low end of that week) | 100-row probe | 103 100 | 14 420 | 0 | 0 | — |
| a fitting list, 14% (low end of that week) | Xonta: batches, checked as it runs | 103 000 | 14 420 | 0 | 0 | — |
| spliced list: 30k fit at 20%, then 73k at 1.28% | budget cap | 24 997 | 5 000 | 0 | 0 | — |
| spliced list: 30k fit at 20%, then 73k at 1.28% | 100-row probe | 84 766 | 5 702 | 60 006 | 17.8 | — |
| spliced list: 30k fit at 20%, then 73k at 1.28% | Xonta: batches, checked as it runs | 31 300 | 6 017 | 1 300 | 100 | 300 / 500 |

## What this shows

1. **On that morning both the probe and Xonta stop almost right away.** The probe is a bit faster, at 100 rows against a median of 200 for Xonta. But in 1.2% of seeds the probe drew 5 or more hits by chance and launched the whole list. Xonta never ran on. The budget cap ran all 103,000 rows, like in the real trace.
2. **On fitting lists neither rule stopped by mistake**, in 500 seeds at 20% and 500 at 14%.
3. **The spliced list is where they differ.** The first 30,000 rows fit at 20% and the other 73,000 don't. The average over the whole list is 6.7%, above the floor. The probe let it through 82% of the time and spent on average 60,000 rows on the part that doesn't fit. In the other 18% it stopped at once and lost the good part too. Xonta stopped every time, with a median of 300 rows after the list went bad. A check done once at the start judges the average. A check that keeps running sees the moment things change.
4. **The cost of the Xonta way is the batch already in flight.** On the spliced list it ran 1,300 rows past the switch on average, because a batch of up to 5,000 had already been launched. A smaller top batch means less loss and more frequent launches.
5. **The budget cap only looks good when the cap happens to land inside the fitting part.** That's what happened on the spliced list. On that morning it let everything run.

## Limits

This is a model of the shares, not a replay of real rows. It ignores rate limits and retries (35,342 refusals that morning) and the time cost. The Xonta parameters (window 300, check every 100, p < 0.01, top batch 5,000) were picked by hand and not tuned. The floor of 5% is the author's and is the same for both rules.
