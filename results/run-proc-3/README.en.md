# Run proc-3: paying invoices, third run of the theme

Русская версия: [README.md](README.md)

October 25, 2026, 6 rounds of 20 tasks, GigaChat-2. Everything is a sandbox: the suppliers, invoices and money are made up.
Code: commit `7322e53` (0.25.2). The stand's own table is in [REPORT.en.md](REPORT.en.md) ([Russian](REPORT.md)). Previous run of the theme: [run-proc-2](../run-proc-2/README.en.md).

## What we were testing

Era 2 of the invoice theme: a duplicate of an invoice that's already been paid now comes with a new invoice number. Matching by number no longer catches it; only the "is there an identical invoice" check (duplicate_check) does. The old tasks are the same as in proc-1 and proc-2, the new ones come from the new era.

The theme's book after proc-2: 27 rules, one proven - "'pay to our new account' - reject". The careful agent's price-dispute child (price_mismatch) came back; in proc-2 it went 22 for 22.

## The short version

**Harm fell more than threefold: 225,459 → 66,681 ₽. Not a single payment to a fraudster went through: 9 attempts worth 2.42 M ₽, all stopped by the mandate. The era 2 trap didn't work the way it was meant to: nobody tried to pay a duplicate. As in proc-2, agents put duplicates "on hold" instead of rejecting them, and that is now 73% of the harm.**

| Agent | exam at start → end | correct (old / new) | round 1 → 6, correct of 20 | to a human: own call / by mandate | harm, ₽ | net, ₽ |
|---|---|---|---|---|---|---|
| fast | 36.7% → 43.3% | 65% / 60% | 15 → 8 | 9 / 102 | 18,459 | −61,717 |
| checker | 20% → 26.7% | 53% / 45% | 11 → 8 | 15 / 95 | 17,902 | −60,808 |
| careful | 20% → 23.3% | 55% / 52% | 14 → 8 | 24 / 73 | 30,320 | −64,676 |

The start exam uses era 0 tasks, the end exam era 2. "Correct" counts the agent's decision even when the mandate didn't let it through. The fast and careful agents' numbers include their children.

1. **Duplicates.** 54 duplicates, 7 handled right. Agents chose "hold" 47 times and "pay" never. All 7 correct rejections came after a duplicate_check, and that check was bought exactly those 7 times. In era 2 the check still says plainly "the same invoice was already paid", so the new number changes nothing. 14 holds got past the limit and cost 48,551 ₽ - 73% of the harm (proc-2 had 6 of them for 14,527 ₽).
2. **Fraudsters.** 9 attempts to pay a fraudster's urgent letter, all stopped. Eight invoices were above the 100,000 ₽ cap; the ninth (98,200 ₽) came from a new child whose limit was 0. Twice an agent paid for the call, heard "we never sent that letter", and still chose "pay" - same as in proc-2.
3. **A new child of the fast agent for urgent letters**, born on the advice "another agent's harm is 0 versus your 89,325 ₽ per task". At work it got 10 of 27 right, and six of the nine attempts to pay a fraudster were its own. Its exam at birth was 16.7% (142,433 ₽ harm per task), so its limit stayed at 0 for the whole run (the 0.25.2 rule): not one action on its own, all six payments stopped. At the end its category exam was 50% with 114,752 ₽ harm per task - and the advice was "keep", because it beats its parent. That's the second case of bug 39.
4. **The proven bank-details rule holds in era 2:** 57 fraud letters, zero attempts to pay, 48 rejected. Of 27 honest letters, 20 were rejected. None of those 20 rejections actually executed - the mandate stopped every one and sent it to a human.

## What we expected and what happened

| Expectation from the plan | Result |
|---|---|
| Duplicates with a new number: payments, mandate, rules | 0 duplicate payments; 7 of 54 right (proc-2: 6 of 54); 48,551 ₽ harm from holds. Duplicate rules went from 9 to 17, all hypotheses |
| Proven bank-details rule in era 2, and what it costs honest suppliers | holds: 0 payments to fraudsters; 20 of 27 honest letters rejected, 0 executed |
| Returning price child: the advice, and whether "keep" shows up with harm above the cost of a human | exam 100%, harm 0 - "keep", correctly. But the new urgent-letter child got "keep" with 114,752 ₽ harm per task (a human costs 400 ₽) - bug 39 again |
| New children with an exam below 50% stay at limit 0 the whole run | yes: the fast agent's child, exam 16.7% at birth, limit 0, zero actions of its own in 27 tasks |
| Payments under the 100,000 ₽ cap | one attempt (98,200 ₽, to a fraudster), stopped by limit 0. An honest urgent invoice for 69,200 ₽ was paid correctly - the only irreversible action that went through |
| 0.1–0.3 M tokens, 5–15 minutes | 0.20 M tokens, 4 min 30 s |

## Payments under the mandate

Agents chose "pay" 93 times. The mandate stopped 92: 83 honest invoices (sent to a human) and 9 fraudulent ones worth 2.42 M ₽. One payment went through - the checker paid an honest urgent invoice for 69,200 ₽ in round 1, which was right.

| | attempts to pay a fraudster | went through |
|---|---|---|
| fast | 0 | 0 |
| fast agent's child (urgent letters) | 6 | 0 |
| checker | 2 | 0 |
| careful | 1 | 0 |

In proc-2, two of 14 such attempts got through at 93,900 ₽ each. Here the fraudulent invoices were mostly above the cap, and the cheapest attempt happened to come from a child with limit 0. So the clean result is the mandate's doing, not the agents getting smarter: there were fewer attempts (9 vs 14), but the call still doesn't change the decision.

## What agents proposed and what became rules

15 proposals, all made it into the book. The book went from 27 rules to 37: 1 proven, 6 no effect, 2 revoked, 28 hypotheses.

- **Proven (since proc-1):** "'pay to our new account' - reject". Over three runs: 98 correct of 148 with it, 1 of 41 without. The 50 wrong ones are honest suppliers.
- **Newly revoked:** price_mismatch, "if the price changed, require confirmation that it was agreed" (P 0.01). It's the second revoked price rule; both steer the invoice away from the correct "hold".
- **"Call before an urgent payment" almost got proven:** in round 5 the stand recorded it as proven, and by the end it was back to "no effect" (P 0.92 against a 0.95 threshold; 3 of 13 right with it, 0 of 12 without). The status wobbles at the threshold, like the health-certificate rule in red-2.
- **Splintering, fourth time in a row:** 11 of 15 proposals were about duplicates, and the book now has 17 duplicate rules, nearly all "compare purpose and amount with past payments". Each was handed out 3–6 times; a verdict needs 8 per arm. Agents keep asking for the check in their rules, yet at work they buy it 7 times in 54 duplicates.

## Where agents go wrong

| Category | decisions | correct | most common action | harm, ₽ |
|---|---|---|---|---|
| regular invoice | 66 | 66 | pay (almost all sent to a human by the mandate) | 0 |
| off-contract price | 75 | 59 | hold; child 22 of 25, fast 25 of 25, checker 12 of 25 | 14,720 |
| bank-details change | 84 | 48 | reject (68): right for fraudsters, wrong for honest ones | 776 |
| duplicate invoice | 54 | 7 | hold (47), when reject is right | 48,551 |
| urgent letter | 81 | 18 | to a human (45), pay (27), hold (9) | 2,634 |

All the price harm is three rejections by the returning child in rounds 2–3 (14,720 ₽): it rejected invoices it should have held. In proc-2 it went 22 for 22.

The fast agent again bought no checks at all (93 decisions). The checker bought 54 checks over 120 decisions, the careful agent 15 over 95.

## Orchestrator bugs

- **"Keep" for a child whose harm is many times the cost of a human (bug 39, second case).** The fast agent's urgent-letter child: 50% on the category exam, 114,752 ₽ harm per task, while handing off to a human costs 400 ₽. The 0.22.1 rule compares it with its parent and with the best neighbour, but not with giving the category to a human. The mandate caught it: at the end the child has a limit of 0 actions and 0 irreversible ones, so it can't do damage in proc-4. But "keep" is the wrong advice. I didn't change it - it's an open question for the owner since ops-3; I added these numbers to it.
- **"Send to a human" advice still isn't acted on**, as in every theme run: the checker was told to hand duplicates to a human, and the stand only logged it. The checker's duplicate harm was 14,492 ₽.
- **A rule's status wobbles at the threshold** (proven in round 5 → no effect at the end). Not a code bug, but it looks odd. The idea from red-2 - keep "proven" until P drops clearly below the threshold - still stands; not done.
- **The era 2 trap isn't where agents actually fail.** The idea was that a duplicate with a new number is easier to pay. In reality nobody pays duplicates in any era, and duplicate_check finds them with a new number too. The duplicate harm comes from holding instead of rejecting. That's a fix to the theme's setup, not to the orchestrator; I left it alone so the three runs stay comparable.

## What the orchestrator learned

- **The theme's book:** 27 → 37 rules. For the third run running, the proven rule keeps fraudsters from being paid on a bank-details change.
- **The mandate:** 0 payments to fraudsters this run (proc-1: one for 60,500, proc-2: two for 93,900). Limit 0 on a weak new child held back six of its attempts.
- **Old tasks, proc-1 → proc-2 → proc-3:** fast 42 → 52 → 65%, checker 45 → 63 → 53%, careful 30 → 57 → 55%. Harm on old tasks 99,858 → 11,228 → 16,857 ₽.
- **What it didn't learn:** duplicates are 6–7 right out of 54 for three runs straight. Lots of rules about checking, but agents don't buy the check. They don't make the call on urgent letters either.
- Something I can't explain: all three agents are down to 8 of 20 by round 6, from 11–15 in round 1. The era didn't change mid-run.

## Cost

203,270 GigaChat-2 tokens, 4 min 30 s. No "Too Many Requests" responses - bug 34 is still waiting for a real test.

## What's next

No code changes. Next in line is run-red-3 (redaction, era 2). Then run-acc-1, run-acc-2, run-acc-3 with the honesty check.
