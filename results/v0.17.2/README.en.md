# 0.17.2: spending receipts, the orchestrator choice rule, the blind spot after a team change, a concurrency limit

Русская версия: [README.md](README.md)

October 19, 2026. Checked on the mock model (`npm run reproduce`, 7 rounds, 12 agents, 4 orchestrators), **12 of 12 claims**. Mock model numbers, not GigaChat.

## 1. Spending receipts

**Where it came from.** A comment by ANP2 Network on dev.to. The mandate says how much an agent may spend, but how much is already gone was known only to the orchestrator, and a relying party had to take its word. In someone else's signed ledger they found a "remaining" field that read 9.95 three times in a row. It had a balance's name and behaved like a constant.

**How we see it.** The orchestrator isn't a bank. An agent can come in through us and spend anywhere, and we'll never see all of it. So whoever moves the money signs the debit. Our job is the judgment on the agent, whether it's honest and spends well, and receipts are raw material for that.

**What changed.**
- A `SpendReceipt` is a W3C credential signed by the executor's did:web key. It carries who paid, under which mandate or allowance, the debit's number in the period, the amount, the balance before and after, and the hash of the previous receipt.
- `POST /v1/receipts` accepts receipts from anyone and checks the signature, that the payer is an agent registered here or its child, that the mandate is ours and not revoked, that the chain has no gaps and that the balance is alive (after equals before minus the amount, and each receipt continues the last one).
- Reconciliation. What the agent says it spent (`POST /v1/agents/ID/spend-claims`) is compared with the receipts of the whole family, the agent and its children. More in the receipts than claimed is hidden spending and the owner gets a signal, less is marked as the agent's own word. The public summary is `GET /v1/agents/ID/spend`.
- Family allowance. A child's allowance is carved out of the parent's, together never more.
- The orchestrator signs receipts itself only for what went through its own gateway (jobs with a budget).
- The sandbox gateway (the sandbox's bank and shop) issues a receipt for every autonomous action (actions left in the period) and for every approved refund (refund allowance left).

**Results.**
- The balance is alive. 82 accounts with several debits, 865 debits, not one account where N debits gave anything other than N distinct falling balances, no receipt problems. Each account's last balance equals the allowance minus the sum of debits.
- Agent 5 in the sandbox leaves its largest refund out of its own report. It was caught by the receipts in 1 of 1 such periods, and no honest agent was accused.
- In the tests, a receipt signed with the wrong key is refused, a dropped receipt shows as a break in the chain, a "balance" of 9.95 → 9.95 after a 0.05 debit is flagged even though the signature is fine, and a child's spending the parent didn't mention shows up in the parent's reconciliation.

## 2. The orchestrator choice rule

**The bug (run-series1-a2).** Agents 7 to 9 stayed with orchestrator 2, which scored 0.97 against 0.66 for orchestrator 1. After c2 it had three control cases, so old recipe outcomes from before 0.14.4, never tagged, started to count. A recipe without a control looked like advice measured against one.

**The fix.** From 0.17.2 every new outcome is tagged and only tagged ones count against control. Old untagged ones are shown separately in the track record (`untagged_before_0_17_2`) and stay out of the comparison. If after that neither orchestrator has a score, the sandbox agent follows the referral, which is itself based on techniques measured against control.

**Check.** A unit test on a book like orchestrator 2's after c2. The 20 old "successful" outcomes don't count and there's no score, and new tagged ones count. The live series will show it in the next run on this code.

## 3. The blind spot after a team change

**The bug.** Right after a team change the mid-period check said nothing at all, since there was no spending norm for the new team yet. A swap in the first period after the change was caught only at the end of the next period. In the short run with the swap in round 3 that was 40 tickets instead of 5.

**The fix.** In that window the agent is compared with the norm of the same team at other agents (the median of their last full period, at least two needed).

**Result.** The same short run with the swap in round 3 now alarms after 5 tickets, zero actions after it, no false alarms. The regular reproduce run (swap in round 5) is 12 of 12.

## 4. A concurrency limit in Gate

In Kevin Hall's trace an agent launched 10 to 11 copies of a metered lookup on one key, and 31% of the requests came back as rate-limit refusals. Gate now allows at most 4 calls of one tool at the same time (`max_concurrent`, settable per tool). An extra call is refused with the explanation that parallel copies on one key don't finish faster.

## Limits

All on the mock model. No real executor sends receipts yet. The format and the checks are ready, and executors are the next step, not our code. The choice rule is checked by a unit test, the live series comes with the next run.
