# Comms agent

The Comms role sits under the Leader. It triages email, iMessage and LinkedIn:
classify, summarize, archive bulk and bot mail, and draft replies. It never
deletes mail. The router and its bandit choose the lane from the lanes that
are actually available. The role names no lane and does not require Grok. When
Grok is one of the available lanes, the router may select it.

This role reuses the channel adapter interface (`ChannelAdapter`) and the
registered bus and handoff adapters. It does not open a second transport.
LinkedIn is delivered only by an official API or a sanctioned connector that
the caller supplies. Scraping is refused.

## Send policy

The policy is code, not prompt text. A prompt cannot approve a recipient.

- A send requires an owner standing approval for that exact transport and
  recipient (`standing-approvals.json` in the Comms directory).
- Everyone else, including a novel recipient, becomes a draft for the owner.
  Email drafts are also copied into `phm drafts` so the desktop drafts card
  can show them. Every draft is recorded on the local owner thread.
- KILL and the comms pause refuse every send.
- Every completed send is appended to the send log. The log stores a Phantom
  Secrets handle (`phm_…`) when one was named, never a credential value.
- A raw credential is refused.

## Commands

```sh
phm comms-agent status --json
phm comms-agent run --lanes claude,local --json
phm comms-agent drafts --json
```

`--lanes` is the candidate set. Omit it and the run reports no lane rather
than picking one. `--dir` selects an isolated runs directory.

MCP tools: `ashlr_comms_agent_status`, `ashlr_comms_agent_drafts`, and
`ashlr_comms_agent_run`.

Records live under `~/.ashlr-runs/comms-agent/` with mode 0600. The inbox is
`inbox.json`. Bulk and bot messages move to `archive.jsonl` and stay readable.
Standing approvals are `standing-approvals.json`:

```json
{ "owners": ["you@example.com"], "approvals": [{ "transport": "email", "recipient": "known@example.com" }] }
```

A missing or malformed file grants no approvals.
