<a id="grok-bot-on-the-bus"></a>

# Grok Bot on the bus — sanctioned join design

> Design note for RQ-BUS-GROKBOT-R (research only, no code). Provider surfaces
> cited from [Grok Bot beside Phantom](GROK-BOT-COMPANION.md), whose vendor
> documentation was checked 2026-10-09; re-check before implementing.

**The bus** is Phantom's work-dispatch fabric: queued items (`fleet/tasks.json`,
the cloud/Devin backlog) flow through `src/core/fleet/dispatch-router.ts` into
lanes, producers deliver on pinned branches, and `src/core/fleet/cloud-intake.ts`
files each delivery as an ordinary proposal under gates G0–G7. "Joining the bus"
means becoming a producer lane — not a side channel around the gates.

## What Grok Bot sanctions (the only doors)

| Surface | Direction | What it can carry |
| --- | --- | --- |
| Routine webhook trigger (`Authorization: Bearer <key>`) | Bus → Bot | **Start a named routine** with a JSON body. HTTP 200 = accepted and started — never completion, evidence, or a result. |
| Marketplace plugins (GitHub, Vercel), user-authenticated | Bot ↔ provider | The Bot's own repo work: branches and PRs on repositories the operator granted, under least-scope auth. |
| Custom MCP server admitted by the user's MCP policy | Bot → Phantom | An incoming tool surface the Bot may call. Admission is a user act; it is not a Phantom API. |
| Bot app approvals, role memory, routine run history | Human ↔ Bot | Operator supervision; not machine-readable bus state. |
| Cursor Admin API | Team settings only | Does not establish personal-Bot dispatch, results, or allowance. |
| xAI model API key | Separate metered product | Not Bot dispatch and never a silent fallback when Bot is unavailable. |

**Refused by definition (sanctioned-path-only clause):** unofficial or private
Bot endpoints, scraped grok.com/X web sessions, browser cookies or phone pairing
reused as agent credentials, inferred headroom from a subscription badge, and any
result-polling API the checked documentation does not describe.

## Design: the `grok-bot` lane

Model it on the Devin lane (`src/core/devin/`), shrunk to the surfaces above.

1. **Admission.** A standing grant names engine `grok-bot` with an enabled
   producer seat; `grokbot.enabled` and an explicit fleet opt-in gate the lane.
   Same shape as Devin: KILL, one decision per tick, sessions-per-day and
   concurrency caps, and an authority-ledger note before and after every
   dispatch.
2. **Dispatch out (bus → Bot).** The tick selects a bounded item (well-scoped
   areas only, brief ≤ the same prompt cap) and POSTs the routine's webhook:
   `{taskId, repo, baseBranch, branch: ashlr-grokbot/<taskId>, title, brief}`.
   The key lives in Phantom Secrets — never in the repo, a prompt, or a URL.
   200 marks the task `dispatched`; non-200/timeout leaves it `queued` with the
   reason. Nothing retries a run; a delivery window that expires escalates the
   task to Needs-you.
3. **Delivery (Bot → GitHub).** The routine's standing instructions carry the
   delivery contract: work only on `ashlr-grokbot/<taskId>` via the GitHub
   plugin, never push or merge elsewhere, open **one draft PR** on the base
   branch titled `[ashlr-grokbot] <title>`, and end the body with a fenced
   `ashlr-grokbot-report` JSON block (`status | summary | testsRun | risks |
   filesChanged` — the same claim shape as `ashlr-cloud-report`). The PR is the
   result. Chat text is never a delivery.
4. **Intake (GitHub → bus).** A new `CloudIntakeSource` —
   `kind: 'grok-bot'`, `branchPrefix: 'ashlr-grokbot/'`, `engineModel:
   'grok-bot:routine'`, tier `frontier` — reuses `ingestCloudPrs` unchanged:
   pinned PR number and head, same repo and base, diff pinned to
   `<merge-base>...<headSha>` and re-read after download, grant ceilings, one
   proposal per (task, head SHA), supersede on new head. The host signs
   provenance for **identity only**; the report block stays UNVERIFIED and G4
   checks it against the diff.
5. **Judging.** Like Devin, Grok Bot is a hosted agent whose per-session model
   is not disclosed: give `grok-bot` its own **review-only family** (never a
   judge family, never a learning-ledger family) so the two-judge rule applies
   — two frontier judges from two different known families, never `grok-bot`
   and never `local`. A merge also needs the live stage to name `grok-bot`;
   otherwise the pass records a would-merge and the App PR waits for the owner.
6. **Metering honesty.** No qualified reader exists for a Bot's remaining
   weekly allowance, reset time, or on-demand state — those stay *unknown*, not
   zero or unlimited. The lane therefore runs on an **operator-attested
   included-usage posture**: the routine is configured with on-demand disabled,
   the operator confirms it, and the fleet records that attestation; it never
   enables on-demand to spend a subscription, and an unreadable meter holds
   dispatches the way an unsettled Devin reading holds ACUs.

## Failure states (all fail closed)

| Signal | Bus behavior |
| --- | --- |
| Webhook non-200 / timeout | Task stays `queued`, reason recorded; no launch claimed. |
| No PR by the delivery window | Task escalates to Needs-you; routine not re-fired. |
| PR off-prefix, retargeted base, or mutated diff | Refused at intake, same as cloud/Devin lanes. |
| Missing/invalid report fence | Proposal filed with report marked UNVERIFIED; G4 decides. |
| Routine disabled, plugin unauthenticated, allowance unknown | Lane reports the reason; nothing dispatches. |

## Phase 2, only if phase 1 proves the need — an MCP bus bridge

A Phantom-hosted read-only MCP endpoint (`bus_assignments`, `bus_brief`,
`bus_report`) that the operator admits through their own MCP policy gives the
Bot a structured claim/report path instead of envelope-in-webhook. Requirements
inherited from the connector rules in [GROK-BOT-COMPANION.md](GROK-BOT-COMPANION.md):
a separate service identity, bounded tool schemas and output, rate limits,
audit receipts, revocation, no transcripts/credentials/grants/mutations, and a
real plugin test from an actual Grok Bot before it is marked available.

## Open unknowns to re-verify before implementation

Checked documentation does not specify: a personal-Bot result or status API,
routine-run status reads beyond the phone app's history, team-vs-personal scope
of routine webhooks, or any Bot allowance reader. Each gap above is routed to an
operator surface (Needs-you, attestation) rather than guessed — the design adds
no assumed endpoint.
