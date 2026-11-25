# Prompt-to-PR from the desktop

From any Verse screen, choose **Improve this screen** and leave **Build it** selected to send a product-change description to the fleet agent. Phantom applies the fail-closed self-report triage: secret-shaped text, protected paths, and non-actionable requests are refused without a job. The agent receives the request as fenced, untrusted data and is asked to make a scoped Phantom change, test it, and open a pull request.

**Just flag it** keeps the existing friction path and appends to `~/.ashlr/router/feedback.jsonl`. **Send to Phantom maintainers** opens a GitHub issue labeled `agent-request`; `phm fleet feedback scan` ingests open issues.

Requests use the existing 1–2,000 character description and 8,000-byte drop-job limits. A deterministic `UIREQ` id deduplicates equivalent descriptions on the same screen; new work is deferred when the shared prompt queue reaches its 40-job limit. Jobs use the `codex-personal` lane and `work` tier.

Both change-request endpoints require dispatch to be enabled and the console mutation token; GET also supplies the normal read-session proof because history reveals job ids. Private JSONL status rows live at `~/.ashlr/router/change-requests.jsonl` and contain only version, id, `RQ-PHX` job id, surface, creation time, and status—not the description. The newest 20 rows include age and a fate only when `readDropJobFates` has evidence; unknown fate stays `null`.

**Your requests** links to a pull request when the fleet records a Phantom PR URL for that job in its local `<job>.publish` receipt or the recent tail of `metrics/jobs.jsonl`. The history endpoint returns `pr: null` without a recorded URL, or `pr: { url, state }` with `open`, `merged`, or `closed` only when the metrics ledger records that outcome for the same PR URL. A publication without an outcome gives a link with `state: null`, not an assumed open PR. History never calls GitHub; it reflects only what the local fleet records contain.
