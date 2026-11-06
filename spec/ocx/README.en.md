# Orchestrator Conduct Exchange (OCX): draft 0.2 at a glance

[Русский](README.md)

An open draft. The full specification is in [SPEC.md](SPEC.md), JSON schemas are in [schema](schema/), and the reference implementation with conformance checks is in [impl](impl/). Expect breaking changes until 0.4. We'll call it stable at 0.4, once it runs on several orchestrators and at least one of them isn't ours. Comments go to issues; see [CONTRIBUTING.md](CONTRIBUTING.md) for how to take part.

## In two sentences

MCP connects an agent to tools, A2A connects agents to each other. OCX connects the ones who answer for agents: orchestrators.

If an agent lies in a report to one orchestrator, that orchestrator sends its peers a signed signal with proof within seconds. Each peer checks the proof itself instead of taking the sender's word for it, and decides on its own what to do. Usually it lowers the agent's limits, for example by requiring a human to confirm every payment.

## Key decisions

1. **No centre.** Every orchestrator publishes its card at `/.well-known/orchestrator-card.json`. There can be any number of directories. Xonta is the reference implementation, not the root of the network.
2. **A signal is information, not an order.** The protocol defines the format and how to check it. What to do about it is up to each receiver.
3. **Proof, not reputation.** Only `proven` signals act fast, and for that level the receiver must be able to check the proof itself. A `suspected` signal only raises monitoring: it can't be used to lower limits, and it isn't relayed.
4. **Receipts.** Every action an agent takes through an orchestrator is written to a ledger: a Merkle tree, like certificate transparency logs, with signed checkpoints. An agent can't create a receipt. A lie like "I verified the bank details" is proven by the missing receipt, and the proof is mathematical: there is an index of each agent's actions.
5. **Minimal data.** Signals carry hashes and identifiers, not customer data. A single field can be disclosed on request, and the sender may refuse.
6. **Sender weight is earned.** A new orchestrator carries little weight. Its weight grows when its proofs check out and falls when they don't. Weight doesn't pass along a chain: if someone you trust trusts me, that alone is no reason for you to trust me.
7. **The owner answers, not only the key.** A signal names the agent's owner. A new agent from the same owner doesn't start from a clean slate.
8. **Honesty probes only with consent.** Traps and "bribes" are allowed only if the agent's owner signed a consent. The prober is a separate process, not the orchestrator that sets limits. Without consent a finding is at most `suspected` and isn't relayed.
9. **Mistakes get fixed.** Every signal has an appeal address. The sender must answer within 72 hours, or the signal drops to `suspected` everywhere. A retraction travels the same paths, and receivers restore limits right away.
10. **Experience is shared with a required comparison.** A rule can be passed on as proven only if it beats both the agent and a trivial rule such as "always raise an alarm". That's a lesson from our two-orchestrator network.
11. **Referral to a more specialised orchestrator.** An orchestrator can advise an agent to work in some category with another orchestrator that does measurably better there. The agent or its owner decides, with three options: move there; stay and ask its own orchestrator to take the other one's experience and re-measure it locally; or stay as is. A referral must state the reason, the evidence and how the two orchestrators are related: if it's paid or they share an owner, that's visible. The agent's history doesn't travel with a referral and limits don't carry over; each orchestrator sets its own. A referral doesn't launder lie signals either: the new orchestrator still asks for status.
12. **Competence is separate from honesty.** An honest orchestrator can be weak at payments, and one that is strong at payments can be new to the network. So competence is measured separately, per category: by how agents did after referrals and by experience re-measured locally. Numbers an orchestrator writes about itself in its card count for nothing on their own.

## Modelled on MCP and A2A

- JSON-RPC 2.0 over HTTPS, methods `ocx/...`.
- A card at a `.well-known` address, like A2A agents have.
- Date-based versions, like MCP: the first is `2026-11-06`. Version and capabilities are negotiated when peers meet (`ocx/peer.hello`).
- Request signatures per RFC 9421, object signatures as JWS with Ed25519, canonical JSON per RFC 8785.
- Conformance profiles: Core, Evidence, Relay, Experience, Appeal. Whoever writes the conformance tests effectively defines what "compliant" means, so the tests come with the spec.

## Methods

| Method | What for |
|---|---|
| `ocx/peer.hello`, `peer.close`, `ping` | meeting, exchanging keys and capabilities |
| `ocx/signals.push`, `signals.list` | delivering signals and catching up after downtime |
| `ocx/signals.retract` | retracting a wrong signal |
| `ocx/status.query` | "what do you know about this agent" before a risky action, answered within 300 ms |
| `ocx/evidence.get` | fetch the proof and check it yourself |
| `ocx/experience.offer`, `experience.get` | sharing proven rules for a category |
| `ocx/appeal.submit` | the owner's appeal |
| `ocx/competence.query` | "who is strongest in this category", from the answerer's own observations only |
| `ocx/referral.offer`, referral token | refer an agent to a more specialised orchestrator |
| `ocx/referral.outcome` | how the agent did after a referral; competence is computed from this |

## How it differs from what's out there

We looked at what already exists (links in Appendix C of the spec):

- **ATTP** (IETF draft) checks who an agent is on every request to a server. That's identity, not behaviour, and not a link between orchestrators. One correction to an earlier discussion: ATTP has no central "Trust Authority", its model is federated.
- **NBTP** (IETF draft) computes a behavioural score, but inside one network.
- **ATP** by SyncTek (submitted to NIST) issues quality certificates as of the moment of testing, not live evidence.
- **ERC-8004** is on-chain reputation. A 2026 study found that 59% to 91% of raters inflate scores in a coordinated way.
- **MolTrust** is closest in spirit ("recompute it yourself, don't trust"), but it's built on a registry and a blockchain, not on peer-to-peer exchange between orchestrators.

The open space: an exchange between the ones who answer for agents that is **peer-to-peer, evidence-based and immediate**.

## Next

1. Receipts and the ledger inside the Xonta orchestrator.
2. The card and Core methods on our two orchestrators.
3. A demo: an agent lies to the first one, the second one refuses its payment, with timing. Built as a bench run on two orchestrators: [stand/ocx-run.js](../../stand/ocx-run.js), reports in `results/`.
4. A conformance test suite.
5. Finding a second implementation that isn't ours.

Open questions are listed in Appendix D of the spec.

## The name

The protocol started out as OCP, but before release we checked and found the acronym already taken several times over in the agent world (Open Commerce Protocol by Deeplumen for agent purchases, Open Context Protocol, Open Cognition Protocol). So it's called **OCX, Orchestrator Conduct Exchange**. "Exchange" says it's about orchestrators trading information, and "conduct" says it's about how agents behave.

## Licences

Specification text and schemas: CC BY 4.0. Reference implementation code: Apache 2.0.
