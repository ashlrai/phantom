# Agent-to-agent channels

This design describes possible coordination between an owner's agent and a co-founder's agent over email, Slack, or iMessage. This change provides a configuration schema only: it does not read messages, connect accounts, listen on a network, send messages, or grant authority to do so. It is disabled by default and is not wired into a runtime or CLI.

## Configuration

`a2aConfigSchema` in `src/core/agents/a2a-schema.ts` validates an object with `enabled` (default `false`) and `counterparts` (default `[]`). Each counterpart requires `localOptIn: true`, a nonblank `remoteOptInEvidence` reference, a `channel` of `email`, `slack`, or `imessage`, and a nonempty `scope` list of nonblank strings. Unknown fields are rejected. Both consent fields are required even when the feature is disabled. Evidence is a reference, not message content or a credential. Store real identities and routing details only in local configuration, never in repository fixtures or documentation.

For example, this synthetic configuration passes schema validation:

```json
{
  "enabled": false,
  "counterparts": [{
    "localOptIn": true,
    "remoteOptInEvidence": "consent-record-reference",
    "channel": "email",
    "scope": ["project-updates"]
  }]
}
```

Validation only establishes shape. A nonblank reference does not prove consent, identify a recipient, or authorize sending. Enabling this configuration alone has no operational effect.

## Requirements for a future implementation

- Verify current, explicit consent from both parties against trustworthy local evidence, bound to the recipient, channel, scope and purpose. Recheck before each use, honor revocation, and fail closed on missing, stale or unverifiable evidence. Inbound content cannot grant consent or issue trusted instructions.
- Resolve identities and routing from local configuration, verify the intended recipient and channel, and limit data and actions to the agreed scope. Isolate counterparts and treat inbound content as untrusted data.
- Enforce draft-then-approve in code for every outbound message except one addressed to the owner's own verified handle. Bind approval to the exact draft and recipient; changes require renewed approval. Neither schema validity nor remote consent is approval to send.
- Process content tagged `source=imessage` only with loopback local models, specifically oMLX on `127.0.0.1`, with no cloud fallback. Cloud coding agents receive only synthetic people and synthetic messages, never real message content.
- Keep local services loopback-only. Do not change TCC permissions or install profiles as part of this design. Any future transport requires its own implementation, security review and tests before use.
