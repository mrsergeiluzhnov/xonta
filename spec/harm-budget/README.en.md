# Harm Budget for Agents

A small open specification for bounding the worst-case harm an owner's AI agents can do in a period, independent of how good any single agent is.

Status draft, v0.1. Part of Xonta. Reference implementation in [`src/gate-risk.js`](../../src/gate-risk.js). Russian version in [README.md](README.md).

## Why

Common agent limits count the wrong thing. Token budgets, step limits and call-rate caps bound how much an agent works, not how much a mistake can cost. An agent can stay well inside a step limit and still issue one refund for the wrong amount, export a full customer table, or change bank details. The expensive errors are rare and large, and rate limits do not see them.

A harm budget bounds the thing the owner actually cares about, which is how much they are willing to lose. It is stated in money, or another unit of harm, and it is shared across every agent the owner runs. It reads cleanly into a risk register, which is why it is easier to explain to finance and compliance than a token count.

## Model

A harm budget uses one unit of harm, usually money, and three checks that are independent of each other.

1. Expected harm. How much an agent is allowed to do on its own, earned from its record. This is the action budget and it is out of scope here.
2. Exposure. The worst a single call can cost, read from the call's own arguments and capped per tool, whoever asks.
3. The owner pool. A single shared budget for a period that every agent and process of one owner draws from, atomically, so parallel agents cannot together spend more than the owner allowed.

This document defines checks 2 and 3. Together they are the harm budget.

## Exposure, the worst case of one call

Before a call goes out, the gate computes its exposure, the most it could cost if it does the worst allowed thing. Exposure is read from the call's arguments.

- A fixed `exposure` for tools whose cost does not vary.
- `amount_arg`, the numeric value of an argument times an optional `factor`, for a payment or a refund.
- `count_arg` times `per_item` for a bulk read or export, with `default_count` used when the count is absent.
- `rules`, an ordered list where the first match wins, for cost that depends on content. A message with three or more email addresses in its body, for example, is treated as a data export rather than a note.

One rule is strict. If the amount or count cannot be read, exposure is the tool's ceiling, never zero. Unreadable input is treated as the worst case, so a malformed or hostile call fails closed instead of slipping through as free.

Each tool has `max_per_action`, the most one call of it may cost without a human. A call whose exposure is above that cap is held for a person. A cap of zero means the tool always needs a human.

## The owner pool

All of one owner's gates open the same pool, a small state file keyed to that owner. Every change to it is atomic across processes through a lock, so many agents running at once share one honest view of what is left.

A call is handled in two steps.

- Reserve. Before the call runs, its exposure is reserved against the pool. The reservation succeeds only if the whole worst case fits next to what is already spent and reserved by others. All or nothing. If it does not fit, the call is held for a human.
- Settle. After the call returns, the reservation is settled. Success books the actual cost, which is never more than the reservation. An error releases the reservation and books nothing.

Three rules keep the pool honest under real conditions.

- Late harm. Harm found after the fact, a chargeback or a leak noticed next week, is booked against the period it is reported in. It lowers what is left for everyone, which is the correct incentive.
- Crash safety. A reservation that is never settled, because its process died, is booked as spent after a timeout rather than dropped. A crash costs budget, it does not quietly free it.
- Period reset. At the end of a period the pool starts clean, with no reservation carried across the boundary. The closing period already counted that exposure.

## Decision

A call is allowed when its exposure is at or below its tool cap and fits in the owner pool. Otherwise it is held for a human, with a reason that states the number. The gate never guesses a lower cost to let a call through.

## Relationship to receipts

The pool bounds how much exposure can be outstanding and spent in a period. It is a budget, not the ledger of record. The authoritative record of what was actually spent is the signed receipt log, which an implementation should write and which anyone can verify by public key. A boundary-straddling action may not land in either period's pool total, and that is fine, because the real spend comes from the receipts, not the pool.

## Policy

A harm budget is a JSON object. The schema is in [`harm-budget.schema.json`](harm-budget.schema.json). Example.

```json
{
  "budget": 20000,
  "period_seconds": 86400,
  "currency": "RUB",
  "pool_file": "/var/lib/xonta/acme.pool.json",
  "reserve_ttl_seconds": 900,
  "unknown_action_exposure": null,
  "tools": {
    "refund_order":        { "amount_arg": "amount", "max_per_action": 3000 },
    "export_customers":    { "count_arg": "limit", "per_item": 50, "default_count": 1000, "max_per_action": 5000 },
    "change_bank_details": { "exposure": 250000, "max_per_action": 0 },
    "send_email":          { "rules": [{ "arg": "body", "count": "[\\w.+-]+@[\\w-]+\\.[\\w.]+", "min": 3, "exposure": 50, "per_match": true }], "max_per_action": 500 }
  }
}
```

In this example one refund is held above 3000, an export of more than 100 rows is held, a change of bank details always goes to a human, and an email with three or more addresses in it is treated as a small data export.

## Conformance

An implementation conforms when it does all of the following.

- Computes exposure from the call's arguments and treats an unreadable amount or count as the tool ceiling, not as zero.
- Holds any call whose exposure is above its tool cap, and always holds a tool with a zero cap.
- Reserves exposure before the call and settles after, all or nothing, booking actual cost on success and releasing on error.
- Shares one pool per owner across processes atomically, so concurrent agents cannot together exceed the budget.
- Books late harm to the current period, and books a never-settled reservation as spent.
- Starts each period with no carried reservation.

## License

This document is part of Xonta and is released under the repository license, Apache-2.0.
