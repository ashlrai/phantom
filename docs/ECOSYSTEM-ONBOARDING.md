# Ecosystem onboarding — one command

```bash
npm i -g @ashlr/phantom      # or: brew install ashlrai/phantom/phantom
phm ecosystem up              # alias of `ashlr ecosystem up`
```

`ecosystem up` lets Phantom work autonomously across the whole Ashlr ecosystem:
`phantom`, `phantom-secrets`, `lexicon`, `locus`, `ashlr-stack`, `ashlr-md`, `ashlr-plugin`.

| Step | What it does | Writes |
|---|---|---|
| github | `gh auth status` | nothing |
| workspace | finds each repo under the workspace (`--workspace`, `$ASHLR_ECOSYSTEM_ROOT`, else `~/ashlr`) or at any already-enrolled path with the same name; clones the rest with `gh repo clone` | clones |
| enroll | adds each repo to `~/.ashlr/enrollment.json` (same as `ashlr sandbox enroll`) | enrollment |
| doctor | per repo: auto-merge on, required CI checks on the default branch, no `ashlr/verify` requirement. Prints the exact fix command; never changes GitHub | nothing |
| grant | shows one scope summary (repos, allowed actions, reserved actions), asks once (or `--yes`), then signs a new standing grant over the enrolled repos with Touch ID | grant |
| schedule | ensures the steward automations (`fix-red-main`, `fix-labeled-issues`, `nightly-flaky-tests`) exist and are enabled, scoped to the grant's repos | automations |
| resident | reports the daemon; `ashlr authority resident start` (you confirm) runs the schedule | nothing |

Every step is idempotent: a second run prints `already` for finished steps and changes nothing.

**Always reserved for the human**, whatever the grant says: release tags and publishing, secret creation/rotation, deletes, any spend (metered spend is $0/day), outside messages, and changes to CI gates, rulesets or the grant itself.

Flags: `--yes` (skip the one confirmation; Touch ID still applies), `--dry-run`, `--json`, `--repos a,b`, `--no-clone`, `--no-schedule`. `ashlr ecosystem status [--json]` is the read-only version.

## Agents

- MCP: `ashlr_ecosystem_status` (read) and `ashlr_ecosystem_up` (append: clone, enroll, schedule). Agents can never sign the grant; when it is missing the result has `grant: waiting-on-you` and `nextCommand: "ashlr ecosystem up"` for the human.
- CLI: `ashlr ecosystem status --json` / `ashlr ecosystem up --json` (schema `ashlr-ecosystem-up` v1).
- Console: **Control → Ecosystem** (`http://localhost:7777/#/control/ecosystem`) shows the same report per repo with an **Enable autonomy** button (dispatch token; never signs the grant).
