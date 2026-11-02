# Repository signals

Run `phm signals --json` in a repository checkout. Output order is stable for
identical sources. Reads only; no model, billing, Brex, or credential inspection.
Each unavailable or invalid metric prints `"no source"`; observed zero and false
remain zero and false. GitHub reads use the existing `gh` authentication.

Stars and forks come from GitHub repository metadata. npm weekly downloads use
package.json's package name and npm's last-week endpoint, retaining its dates.
The used list examines the latest 100 merged PRs and reports paths touched again
in local HEAD's descendants of each merge. It is bounded evidence of subsequent
path use, not proof of semantic adoption or an exhaustive import analysis.
Missing local merge ancestry or failed reads make this list `"no source"`.

Optional repository-root static files (no network fallback):

- `adoption-scoreboard.tsv`: header must contain `repo`; rows match the exact
  GitHub `owner/repo`. Output preserves columns and sorts matching rows.
- `mcp-installs.json`: `{"repo":"owner/repo","installs":42}` from a measured
  install source. Local MCP configuration counts are not install telemetry.
- `revenue-signals.json`: `{"repo":"owner/repo","revenue":false}` filled by
  Masbot. Only an explicit boolean is accepted. No financial API is called.

Do not put credentials or customer details in these aggregate source files.
