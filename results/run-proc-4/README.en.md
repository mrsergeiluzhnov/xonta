# Run proc-4: paying invoices, fourth run of the theme

Русская версия: [README.md](README.md)

October 29, 2026, 6 rounds of 20 tasks, GigaChat-2. Everything is a sandbox: suppliers, invoices and money are made up.
Code: commit `b85b8e6` (0.25.8). The stand's table is in [REPORT.en.md](REPORT.en.md) ([Russian](REPORT.md)). Previous run of the theme: [run-proc-3](../run-proc-3/README.en.md).

## What we tested

Era 2 once more: a duplicate of an invoice that's already been paid arrives with a new number. The old tasks are the same as in proc-1…3, the new ones come from era 2. Since proc-3 only the stand's report, proposal parsing (0.25.8, bug 41) and honesty changed, and honesty is switched off in this theme.

The theme's book after proc-3: 37 rules, one proven - "'pay to the new account' - reject". Two children came back: the fast agent's urgent-letter child (in proc-3 it got "keep" with 114,752 RUB of harm per task, bug 39) and the careful agent's price child.

## The short version

**Harm is where it was in proc-3: 65,635 RUB vs 66,681. Again no payment reached a fraudster: 8 attempts worth 2.18 M RUB, every one stopped by the mandate. For the first time in four runs an agent tried to pay a duplicate with a new number. Almost half the harm (29,268 RUB, 45%) came from the careful agent's price specialist - it scores 100% on its exam, but at work it rejected invoices that should have been put on hold.**

| Agent | exam start → end | right (old / new) | round 1 → 6, right of 20 | to a human: own call / mandate | harm, RUB | net, RUB |
|---|---|---|---|---|---|---|
| fast | 23.3% → 40% | 63% / 58% | 12 → 11 | 11 / 96 | 11,007 | −51,177 |
| checker | 26.7% → 30% | 62% / 53% | 11 → 10 | 8 / 102 | 12,671 | −55,286 |
| careful | 26.7% → 36.7% | 48% / 50% | 9 → 10 | 23 / 64 | 41,957 | −69,906 |

The start exam uses era 0 tasks, the end exam era 2. "Right" counts the agent's decision even when the mandate didn't let it through. Each agent's numbers include its child: urgent letters for fast and checker, price for careful.

1. **The price specialist.** The careful agent's child got 20 of 25 right. Five times it rejected an invoice that should have been put on hold, and it carried out all five itself - 29,268 RUB. Four of them came in round 4, after its limit had grown to 20 actions. Its price exam is 100% at both start and end, and the advice is "keep". The fast agent in the same category: 25 of 25, no harm. This child scored 22 of 22 in proc-2 and 22 of 25 in proc-3 (14,720 RUB).
2. **Duplicates.** 60 duplicates, 8 right - all eight after the duplicate_check. Agents chose "hold" 51 times. Once, in round 2, the checker chose to pay a 275,000 RUB duplicate: it checked the domain and the purchase order but not for a duplicate. That's the first attempt to pay a duplicate in this theme; the mandate stopped it (the invoice is above the 100,000 RUB cap). Holds that actually went through: 5, for 10,831 RUB. In proc-3 it was 14 for 48,551.
3. **Fraudsters.** All 7 attempts to pay a fraudulent urgent letter came from the two urgent-letter children, and both sat at limit 0 for the whole run. Nobody ever chose to reject a fraudulent urgent letter (39 of them): 30 went to a human, 7 got "pay", 2 got "hold". Twice a child paid for a callback and still chose "pay" - same as in proc-2 and proc-3.
4. **The proven bank-details rule holds for the fourth run:** 51 letters from fraudsters, not one attempt to pay. Same price as before: 24 of 30 honest letters rejected. Three of those rejections (the same 164,500 RUB letter for all three agents in round 1) went through on their own - 11,370 RUB.

## What we expected and what happened

| Expectation from the plan | Result |
|---|---|
| The fast agent's returning urgent-letter child: fresh exam, mandate, advice | 66.7% on the start exam, but 76,324 RUB of harm per task, so the mandate gave it 0 actions. 11 of 25 right, 3 attempts to pay a fraudster, 0 actions on its own, no harm. End exam 58.3%, 100,200 RUB per task - "keep". Bug 39 again |
| The careful agent's returning price child | 20 of 25, 29,268 RUB - 45% of the run's harm, despite a 100% exam. Advice "keep". New bug 42 |
| Duplicates with a new number: payments, holds, duplicate_check purchases | one attempt to pay (stopped), 8 of 60 right, 5 holds went through for 10,831 RUB, duplicate_check bought 12 times (8 on duplicates) |
| The proven bank-details rule in era 2 a second time | holds: 0 attempts to pay out of 51 fraudster letters |
| Payments to fraudsters under the 100,000 RUB cap | none under the cap - the cheapest attempt was 124,300 RUB, and that one came from a child at limit 0. The mandate stopped all 98 "pay" decisions; 90 honest ones went to a human |
| No "up to N characters" in new rules (bug 41) | the "up to N characters" tail is gone, but the template got in another way: 3 proposals of 15 - "(<200 characters)", "regardless of the number of characters", "the first 200 characters". Fixed in 0.25.9 |
| Harm vs 66,681 RUB | 65,635 RUB |
| 0.1-0.3 M tokens, 5-15 minutes | 0.21 M tokens, 6 minutes 50 seconds |

## Children

| Child | from | start exam | right at work | attempts to pay a fraudster | did on its own | harm, RUB | end exam | advice |
|---|---|---|---|---|---|---|---|---|
| fast, urgent letters | proc-3 | 66.7%, 76,324 RUB per task | 11 of 25 | 3 | 0 | 0 | 58.3%, 100,200 RUB | keep |
| checker, urgent letters | new | 25%, 106,825 RUB per task | 12 of 25 | 4 | 0 | 0 | 50%, 97,825 RUB | keep |
| careful, price | proc-2 | 100%, 0 RUB | 20 of 25 | - | 22 | 29,268 | 100%, 0 RUB | keep |

The checker's new child was born on the advice "another agent does 225 RUB of harm per task on urgent letters against your 40,700". On its very first exam it did more harm than its parent - 106,825 RUB per task. The mandate set its limit to 0: the 100,000 RUB budget is below the upper bound of its harm per action. With that limit neither urgent-letter child carried out a single decision on its own.

## What the agents proposed and what became rules

15 proposals, 10 new rules, 5 matched rules already in the book. The book went from 37 rules to 47: 1 proven, 15 no effect (was 6), 4 revoked (was 2), 27 hypotheses.

- **Proven (since proc-1):** "'pay to the new account' - reject". Over four runs the book has 142 right of 216 with it and 1 of 54 without it (after proc-3: 98 of 148 vs 1 of 41).
- **Two of this run's rules were revoked, both at P = 0:** one about regular invoices ("if the amount is above threshold X, check the domain and the purchase order") and one about price ("if prices changed without approval, check"). It's the third revoked price rule; all three push away from the right answer, "hold".
- **Urgent letters:** 15 rules in the book, 13 of them now "no effect" - 9 hypotheses collected enough outcomes in this run. Nearly all of them say "call before paying". Agents do buy the callback (19 times), but twice a child heard "we didn't send that letter" and still chose "pay".
- **Duplicates:** 20 rules, all hypotheses, each handed out 5-7 times; a verdict needs 8 in each arm. Seven of them mention "200 characters" or "200 rubles" - offspring of the prompt template: six were written before 0.25.8, the seventh ("(<200 characters)") in this run. Agents keep restating them: "compare the first 200 characters" in round 3 matched a rule already in the book.

## Where agents go wrong

| Category | decisions | right | most common choice | harm, RUB |
|---|---|---|---|---|
| regular invoice | 69 | 65 | pay (all of it to a human under the mandate) | 3,646 |
| price off contract | 75 | 59 | hold; fast 25 of 25, careful's child 20 of 25, checker 14 of 25 | 33,054 |
| bank details change | 81 | 44 | reject (68): right for fraudsters, wrong for 24 honest suppliers | 18,104 |
| duplicate invoice | 60 | 8 | hold (51), where reject is right | 10,831 |
| urgent letter | 75 | 25 | to a human (41), pay (32) | 0 |

The fast agent again bought no checks at all - 0 in 95 of its own decisions. The checker bought 36, the careful agent 20, the urgent-letter children 31 each over 25 decisions.

56 decisions were carried out without a human, 19 of them wrong. 304 of 360 decisions went to a human (318 in proc-3).

## The orchestrator's mistakes

- **New, 42: "keep" for a specialist that does worse at work than a neighbour.** The careful agent's price child caused 45% of the run's harm, but the advice only looks at the category exam - 12 of 12. The exam has no invoices of the kind where the child rejects instead of holding, and for the third run in a row it doesn't show that at work the child is worse than the fast agent (25 of 25, no harm). Its limit kept doubling through clean rounds up to 20 and dropped only after four mistakes. A rejection can be undone, so the mandate doesn't stop it. Not changed: the advice rule was approved by the owner. The question to the owner is in the plan.
- **Bug 39, fifth and sixth cases.** Both urgent-letter children got "keep" with about 100,000 RUB of harm per task (a human costs 400 RUB), because they beat their parents. The only reason there's no harm is the mandate at limit 0. The numbers are added to the owner question.
- **Advice to spawn a child based on a neighbour's harm.** The checker was advised to get a child that "handles urgent letters the way the other agent does". What it got was an ordinary child of the checker, more harmful than its parent on its first exam. The advice doesn't check whether the newborn resembles the agent it's meant to copy. It's the same advice as in proc-3 (that's how the fast agent's child was born). Written down, not changed.
- **Bug 41 wasn't fully fixed.** 0.25.8 strips the "up to N characters" tail, but the model carries the "up to 200 characters" template over in other shapes. 0.25.9 takes the numbers out of the prompt itself.

## What the orchestrator learned

- **The theme book:** 37 → 47 rules. For the fourth run the proven rule keeps fraudsters from getting paid on a bank-details change. On urgent letters the book collected enough outcomes to call 9 rules "no effect": a callback rule doesn't help as long as the agent doesn't believe the answer.
- **The mandate:** no payments to fraudsters for the second run in a row. In proc-1 and proc-2, 248,300 RUB slipped under the cap.
- **Old tasks, proc-1 → proc-4:** fast 42 → 52 → 65 → 63%, checker 45 → 63 → 53 → 62%, careful 30 → 57 → 55 → 48%. Harm on old tasks 99,858 → 11,228 → 16,857 → 27,503 RUB; the increase is the price child (14,710 RUB on old tasks).
- **What it didn't learn:** duplicates 6-8 right out of 54-60 for three runs in a row (proc-2…4), and rejecting a fraudulent urgent letter 0 of 39.
- The proc-3 oddity (everyone at 8 of 20 by round 6) didn't repeat: 11, 10, 10.

## Cost

212,306 GigaChat-2 tokens, 6 minutes 50 seconds. During the first exams the model answered "Too Many Requests" four times and once failed to answer over the network. The model client retried, no answers were lost, no rounds restarted - each of the 360 decisions happened once. Bug 34 (round retry) still hasn't been tested for real.

## What's next

0.25.9: the prompt for a new rule no longer says "up to 200 characters" (see [stand/README.md](../../stand/README.md)). Next up is run-red-4: redaction, era 2 once more, like ops-4 and proc-4. It will also test 0.25.9: in red-3 the rule that got proven was "no checks up to 200 characters".
