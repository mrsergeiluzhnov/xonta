# Experience transfer between agents, run 1: a head office phone

Русская версия: [README.md](README.md)

October 22, 2026. Real sites, real GigaChat, a separate copy of the Xonta 0.19 orchestrator. Agent A on GigaChat-2, agent B on GigaChat-2-Pro. Ground truth is the phone the company itself reports to the SEC (EDGAR). 199 companies, 72 for training, 127 holdout, list fingerprint `7cd6865c350b9491`. Code in [research/contact](../../research/contact).

## Setup

Agent A ran the training companies plainly and with each of three strategies. People wrote the strategies. The one that most often turned a failure into a right answer was proposed to the orchestrator by agent A as a recipe. Agent B asked the orchestrator for a recipe on holdout companies. The orchestrator assigned paired mode, so every task ran with and without the recipe. Only a number that matched the ground truth counted.

## What the run report said

| Sample | tasks | blocked (403) | no pages | no numbers | right number among candidates | accepted | correct | accepted but wrong |
|---|---|---|---|---|---|---|---|---|
| A, plain | 72 | 22 | 7 | 14 | 9 | 6 | 5 | 1 |
| B, without recipe | 127 | 37 | 10 | 30 | 19 | 4 | 4 | 0 |
| B, with recipe | 127 | 36 | 9 | 33 | 19 | 10 | 7 | 3 |

Agent A proposed one recipe, `labels:hq-wide` (recognise head office labels more broadly), with 5 fixes and 1 break on training. At agent B the orchestrator counted 3 tasks better with it and 0 worse out of 127 and didn't mark it proven (p ≈ 0.125).

## What the row-by-row check showed

**Model failures skewed the comparison.** GigaChat sometimes returned an error, 21 of 288 times at agent A and 9 of 254 at agent B. Dropping pairs where either arm hit one:

- on training, `locale:en-us` and `pages:investor-and-offices` did nothing, every "fix" was a case where the plain run had failed. `labels:hq-wide` fixed 2, broke 1 and added 1 wrong number. With a threshold of 3 fixes it wouldn't have been proposed;
- on holdout, of 118 clean pairs the recipe gave the right number where the plain run abstained once (Gilead). It accepted a wrong number where the plain run abstained twice (Union Pacific, Norfolk Southern). Both right 4, both abstained 111. Two of the three "wins" in the report (Occidental, Dow) were a model error in the control arm.

**A wrong number counted as a tie.** The 0.19 evaluation looked only at right or not. If the plain run didn't answer and the recipe accepted a wrong number, it went into "both wrong". Accepting someone else's number is worse than not answering. Counting that, the recipe is more harmful than not, 1 better, 2 worse.

The orchestrator did the right thing and didn't approve the recipe. But for an incomplete reason.

**Where companies are lost.** 29% of sites answer 403, and 36 of the 37 blocked are US companies. Part of them seem to refuse addresses in Russia. The right number was among the candidates at all in only 19 of 127 tasks. Most companies don't publish a head office phone on the pages the agent reaches. A recipe at the number-choice stage can't do much here.

## Fixed after the run (0.19.1)

- Outcomes count harm. Right is 1, abstained 0, accepted a wrong one -1, and the arm with the higher score is better.
- A pair where one arm failed for infrastructure reasons is marked `invalid` and doesn't count.
- The agent retries GigaChat on 429 and network failures, and the runner drops such pairs on training and holdout.

The recipe and the strategy menu didn't change. Run 2 uses the same companies and the same split.
