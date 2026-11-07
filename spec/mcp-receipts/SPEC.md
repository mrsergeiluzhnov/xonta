# MCP extension `ru.xonta/receipts`: signed receipts for tool calls

**Identifier:** `ru.xonta/receipts`
**Version:** 2026-11-07 (draft)
**Status:** unofficial MCP extension in the sense of [SEP-2133](https://modelcontextprotocol.io/seps/2133-extensions). It is not recognised by MCP governance and may change without notice.
**Editor:** Sergei Luzhnov (Xonta)
**Reference implementation:** Xonta Gate, `src/gate.js` in this repository
**License:** text CC BY 4.0, code Apache 2.0

## 1. Problem

An agent's report about what it did is a claim, not evidence. In the Xonta honesty benchmark (`bench/honesty`) three models (GigaChat-2, llama3.1:8b, qwen2.5:7b) never misreported on their own, but when someone asked them to make a report look better they did so in 50 to 67.5% of reports. Asked to claim a check they never ran, all three did it every time, 57 of 57. GigaChat-2 never said it had been asked.

An auditor, an orchestrator or another agent that wants to know whether `verify_bank_details` was really called needs a record that does not come from the agent. The MCP server, or a gateway in front of it, is the natural place to produce that record: it sees every call.

This extension lets an MCP server hand the client a signed receipt for each `tools/call`. The client can keep it, show it to a third party, and prove what was sent and what came back, without the server publishing arguments or outputs.

## 2. Terms

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

- **Issuer**: the MCP server or gateway that signs receipts.
- **Receipt**: a signed record of one `tools/call` handled by the issuer.
- **Log**: the issuer's append-only, hash-chained list of records. Every receipt is a record of the log.
- **Commitment**: a salted hash of a value that hides the value but lets its holder prove it later.

## 3. Negotiation

### 3.1 Issuer

An issuer that supports this extension MUST advertise it in `ServerCapabilities.extensions` in the `initialize` response:

```json
"capabilities": {
  "tools": {},
  "extensions": {
    "ru.xonta/receipts": {
      "version": "2026-11-07",
      "alg": "EdDSA",
      "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "...", "kid": "...", "alg": "EdDSA", "use": "sig" },
      "commitments": "sha256(nonce LF JCS)"
    }
  }
}
```

`jwk` is the issuer's current public key. `kid` MUST be the RFC 7638 thumbprint of the key. An issuer reachable over HTTP SHOULD also publish its keys as `{"keys": [jwk, ...]}` at a stable URL, so receipts stay verifiable after the session ends. Xonta Gate uses `GET /gate/key`.

### 3.2 Client

A client opts in in either of two ways:

1. by advertising `"ru.xonta/receipts": {}` in `ClientCapabilities.extensions` at `initialize`;
2. by putting `"ru.xonta/receipts": {}` into `params._meta` of a `tools/call` request.

The second way exists because a stateless HTTP server may handle `initialize` and `tools/call` on different instances and cannot rely on what the client said at `initialize`.

An issuer MUST NOT attach receipts to responses of a client that did not opt in, as SEP-2133 requires extensions to be off by default. A client that does not understand the extension sees an unchanged response.

## 4. Receipt

### 4.1 Where it goes

For every `tools/call` the client opted in for, the issuer MUST attach a receipt to the result, whether the call was allowed, refused by the issuer, or failed upstream:

```json
"result": {
  "content": [ ... ],
  "isError": false,
  "_meta": {
    "ru.xonta/receipts": {
      "receipt": { ... },
      "nonce": "3f1c...e9",
      "kid": "Yk3...Q"
    }
  }
}
```

`nonce` is 16 or more random bytes, hex encoded, fresh for every receipt. It is given to the client only and MUST NOT be written to the log.

### 4.2 Fields

The receipt is a JSON object. These members are REQUIRED:

| member | meaning |
|---|---|
| `seq` | position in the issuer's log, starting at 1, without gaps |
| `ts` | time the record was written, RFC 3339 in UTC |
| `event` | `"call"` |
| `tool` | tool name as requested |
| `decision` | `"allowed"` if the call was passed upstream, `"refused"` if the issuer refused it |
| `receipt` | extension version, `"2026-11-07"` |
| `args_commit` | commitment to the arguments the issuer passed upstream (§4.3) |
| `out_commit` | commitment to the `content` array returned to the client (§4.3) |
| `prev` | `hash` of the previous record in the log, or 64 zeros for the first one |
| `hash` | lowercase hex SHA-256 of the JCS (RFC 8785) serialisation of the receipt without `hash` and `sig` |
| `sig` | base64 Ed25519 signature over the 32 raw bytes of `hash` |

The issuer MAY add other members, for example why a call was refused or whether the tool reported an error. They are covered by `hash` like any other member. Verifiers MUST ignore members they do not understand.

The receipt is byte for byte the record the issuer keeps in its log. Members with no value are left out rather than set to `null`.

### 4.3 Commitments

```
commit(nonce, value) = lowercase hex SHA-256( nonce || 0x0A || JCS(value) )
```

`args_commit` commits to the arguments object the issuer passed upstream. If the issuer removed or replaced some arguments before passing them on, for example personal data, it commits to what it passed, not to what it received. `out_commit` commits to the `content` array of the result returned to the client, including when the issuer itself produced the result.

The salt keeps short arguments such as `{"id": 2}` from being guessed from the log by trying likely values. The holder of the nonce can reveal it, together with the value, to whoever it chooses.

## 5. Verification

Given a receipt object `m` (the value under `_meta["ru.xonta/receipts"]`) and the issuer's key `jwk`, a verifier:

1. checks that `m.kid`, if present, equals `jwk.kid`;
2. removes `hash` and `sig` from `m.receipt`, serialises the rest with JCS, and checks that its SHA-256 equals `hash`;
3. checks `sig` over the raw bytes of `hash` with `jwk`;
4. if it was given the arguments, checks `commit(m.nonce, args) == args_commit`;
5. if it was given the output, checks `commit(m.nonce, content) == out_commit`.

A receipt that passes steps 1 to 3 proves that the issuer recorded a call to `tool` with this decision at position `seq`. Steps 4 and 5 prove which arguments and output it was.

A receipt alone does not prove that no other calls happened. A verifier that needs this asks the issuer for the log segment between two `seq` values and checks the `prev` chain. Exposing the log is out of scope of this version.

## 6. Use with OCX

[OCX](../ocx/SPEC.md) lets orchestrators exchange evidence about agent behaviour. Receipts from this extension are one source of that evidence:

- an agent reports `"checks": ["invoice_match", "verify_bank_details"]`;
- the orchestrator holds receipts for the task window and none of them has `tool: "verify_bank_details"` with `decision: "allowed"`;
- it can issue an OCX signal with `ledger_mismatch` evidence and attach the receipts, which any peer verifies with the issuer's key without trusting the orchestrator.

## 7. Security considerations

- **Key compromise.** Whoever holds the issuer key can sign any receipt. Issuers SHOULD keep the key out of reach of the tools they front and SHOULD rotate it by publishing the new key next to the old one.
- **Issuer honesty.** A receipt proves what the issuer recorded, not what the upstream tool really did. A gateway that is itself compromised can sign false receipts. The `prev` chain makes it hard to rewrite history after the fact, but not to lie at the moment of writing.
- **Replay.** A receipt can be shown many times; it is a statement about the past, not a token for access. Verifiers that need freshness check `ts`.
- **Untrusted input.** Clients SHOULD validate receipts like any other extension data (SEP-2133, Security Implications).

## 8. Privacy considerations

The log holds tool names, decisions, times and salted commitments, not arguments or outputs. The client holds the nonces and decides what to reveal. A client that forwards a receipt without the nonce reveals that a call happened and nothing about its content.

## 9. Changes

- 2026-11-07: first draft, implemented in Xonta Gate 0.29.
