# Fleet Verbs

`ashlr fleet <verb>` dispatches by file name: a verb is a `src/cli/fleet-<verb>.ts` exporting `cmdFleet<Verb>` (camel case via `resolveFleetSubcommand`). Never edit `src/cli/fleet.ts`, `src/cli/index.ts`, completions or help to add one — the convention resolves it automatically.

| Verb | File | Reads or does | Writes anything? |
|------|------|---------------|------------------|
| backlog | `src/cli/fleet-backlog.ts` | Read-only triage of the open-PR merge backlog | no |
| bet-trace | `src/cli/fleet-bet-trace.ts` | Offline supervisor-command reconciliation; no dispatch or mutation authority | no |
| bus-thread | `src/cli/fleet-bus-thread.ts` | Reads retained live local context only; routing labels are not authenticated identities | no |
| canary-ladder | `src/cli/fleet-canary-ladder.ts` | Read-only report of which auto-merge rung each repo's recent merge outcomes compute on the canary enforce ladder | no |
| ci-failures | `src/cli/fleet-ci-failures.ts` | Reads CI failure groups from a repo, configurable repo and hours window | no |
| ci-nightly | `src/cli/fleet-ci-nightly.ts` | Reads CI nightly hotspots for a repo, configurable repo flag | no |
| class-share | `src/cli/fleet-class-share.ts` | Offline accounting only; never changes dispatch or merge authority | no |
| dead-heads | `src/cli/fleet-dead-heads.ts` | Read-only report; never edits queue state or launches jobs | no |
| dispatch-summary | `src/cli/fleet-dispatch-summary.ts` | Read-only dispatch intent rollup; never writes and never contacts a provider | no |
| edit-collisions | `src/cli/fleet-edit-collisions.ts` | Reads job detail, changes, text and bus inbox for a job ID | no |
| grok-usage | `src/cli/fleet-grok-usage.ts` | Reads Grok usage metrics from a configured source | no |
| job-read | `src/cli/fleet-job-read.ts` | Reads job detail, changes, text and bus inbox for a job ID | no |
| lane-models | `src/cli/fleet-lane-models.ts` | The effective model per lane and tier from models.json, cross-checked against the newest launch row in metrics/jobs.jsonl; read-only | no |
| lane-truth | `src/cli/fleet-lane-truth.ts` | Offline advisory only; never changes a hold or grants dispatch authority | no |
| launch-proof | `src/cli/fleet-launch-proof.ts` | Read one status snapshot and one live process table; never dispatch work | no |
| meter-drop | `src/cli/fleet-meter-drop.ts` | Read-only meter drop verdict from lane state and meter samples | no |
| real-supply | `src/cli/fleet-real-supply.ts` | Read-only live supply for the planner: Dependabot alerts, red scheduled suites and open issues across the seven repos | no |
| runs-read | `src/cli/fleet-runs-read.ts` | Reads runs dir state, leader journal and parked queue | no |
| ship-gap | `src/cli/fleet-ship-gap.ts` | Read-only ship-gap report for the seven approved repos; drift past newest version tag | no |
| stray-slots | `src/cli/fleet-stray-slots.ts` | Read-only host evidence: one lost slot per finished job with leftover processes | no |
| wait-jobs | `src/cli/fleet-wait-jobs.ts` | Waits for fleet jobs by ID, monitors publication status | no |
| workers | `src/cli/fleet-workers.ts` | Lists live workers, filterable by lane, repo and age; watch mode | no |

**Convention for adding a new verb.** Create `src/cli/fleet-<verb>.ts` exporting `cmdFleet<Verb>` (each dash-separated part title-cased and concatenated). The dispatcher in `resolveFleetSubcommand` resolves it automatically; no edits to `fleet.ts`, `index.ts`, completions or help are needed. Update this doc to keep it in sync.
