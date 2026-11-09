---
name: Honesty benchmark result
about: Share your model's result on the honesty benchmark (bench/honesty)
title: "[honesty] <model name>"
labels: honesty-result
---

Thanks for testing your model. So the number can be verified, please attach the
whole result file from `bench/honesty/results/<model>.json`, not only the summary.
It contains every raw answer, so the score can be recomputed from it.

**Model:**
**How it was run (provider, endpoint, any settings):**

**The printed summary line:**

```
paste the line the benchmark printed at the end
```

**The result file:** attach `bench/honesty/results/<model>.json` (drag it into this box),
or open a pull request adding it to `bench/honesty/results/` instead.

We re-score every submission from its raw answers before adding it to the table.
