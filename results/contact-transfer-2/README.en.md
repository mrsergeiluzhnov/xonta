# Experience transfer between agents, run 2: a head office phone

Русская версия: [README.md](README.md)

October 22, 2026, after the 0.19.1 fix. Same 199 companies, same split (fingerprint `7cd6865c350b9491`), same SEC EDGAR ground truth, same strategy menu. Agent A on GigaChat-2, agent B on GigaChat-2-Pro. A fresh orchestrator, GigaChat retries, 2 requests at a time. What happened in run 1 and why it had to be repeated is in [contact-transfer-1](../contact-transfer-1/README.en.md).

## Result

| Sample | tasks | blocked (403) | no pages | no numbers | right number among candidates | accepted | correct | accepted but wrong |
|---|---|---|---|---|---|---|---|---|
| A, plain | 72 | 22 | 7 | 14 | 12 | 8 | 6 | 2 |
| B, without recipe | 127 | 36 | 12 | 30 | 21 | 8 | 7 | 1 |
| B, with recipe | 127 | 37 | 10 | 32 | 21 | 10 | 8 | 2 |

Zero model failures, all 127 pairs counted.

**Agent A** on training: `locale:en-us` changed nothing, `pages:investor-and-offices` fixed 1, `labels:hq-wide` fixed 3 and broke 1. Only the last was proposed.

**Agent B** got the recipe from the live orchestrator on all 127 tasks and applied it. On 5 tasks it changed what the agent did. Pairs scored with harm give 2 tasks better with the recipe, 2 worse, 6 right in both arms, 117 the same. A wrong number was accepted twice with the recipe and once without. Status at the orchestrator is `no_effect`, the recipe isn't approved.

## What it means

- The loop from the owner's report ran with no manual step. Agent A found and proposed a technique, a separate agent on another model got it from the live orchestrator, the use was logged, outcomes were checked against independent ground truth, and the estimate updated on its own.
- No improvement. A recipe that looked like 3 to 1 on training gave 2 to 2 on new companies. The orchestrator didn't approve it, and this time for the right reason.
- The ceiling of this task is low. 28% of sites are blocked, 35 of the 36 blocked are US companies. The right number was among the ones found in only 21 of 127 tasks. The bottleneck is access to the sites and the fact that they rarely publish a head office number, not choosing the number.
- Between runs 1 and 2, agent B's right answers without the recipe went from 4 to 7. That's the model retries, not the recipe.
