# Job cost breakdown

Click a job in the console's fleet view and the detail sheet shows a **Cost**
section: one line per recorded model call — timestamp, model, tokens in,
tokens out, and cost in USD. The same projection backs the CLI and the
loopback API, so a terminal, a script and the browser all read the same
numbers.

A job that ran on a subscription lane (Claude, Codex) may have no per-call
spend rows at all. In that case the sheet still shows what the worker itself
reported at finish (`tokens_total`), and every field without evidence says
`unknown` — never an estimate dressed up as a measurement.

## What the numbers mean

- `calls` — recorded API calls attributed to the job in the spend ledger.
- `inputTokens` / `outputTokens` — summed over the calls that reported them;
  `totals.reported` counts how many calls contributed, so a partial total is
  visible as partial.
- `costUsd` — summed over calls that reported a price; `cost_estimated` rows
  are flagged `(est.)` in the sheet and `estimated: true` in JSON.
- `jobTotals.tokensTotal` — worker-reported tokens from finish events in the
  jobs ledger, shown when no per-call rows exist.
- `sources` — per-ledger health (`healthy` / `missing` / `degraded`); a
  `degraded` source means some lines could not be parsed.
- `truncated` — the read window cut older ledger rows; earlier calls may
  exist beyond it.

No prompt text, log lines or credentials are read for this projection; only
the metrics ledgers under `~/.ashlr-runs/metrics/` are opened, bounded and
without following symlinks.

## Copy-paste example

```sh
phm job cost RQ-APPCOST-11-JOBBREAKDOWN
# Job RQ-APPCOST-11-JOBBREAKDOWN: 2 calls, 12,480 in / 1,936 out, cost $0.2144
#   2026-11-02T03:41:12Z  claude-test-a  12000→1900  $0.2100
#   2026-11-02T03:58:03Z  claude-test-a  480→36  unknown (estimated)

phm job cost RQ-APPCOST-11-JOBBREAKDOWN --json
# {"schema":"fleet.job.cost.v1","job":"RQ-APPCOST-11-JOBBREAKDOWN","calls":[...], ...}

# Loopback console API (read token required):
curl -sS -H 'X-Ashlr-Token: <read-token>' \
  'http://127.0.0.1:7777/api/fleet/job/cost?id=RQ-APPCOST-11-JOBBREAKDOWN'
```

`--runs-dir <abs>` points the CLI at a non-default runs directory (tests and
mounted fleet mirrors). A missing or malformed id exits 2; a read failure
exits 1.
