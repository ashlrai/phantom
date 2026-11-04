# Fleet Verbs

`ashlr fleet <verb>` dispatches by file name: a verb is a `src/cli/fleet-<verb>.ts` exporting `cmdFleet<Verb>` (camel case via `resolveFleetSubcommand`). Never edit `src/cli/fleet.ts`, `src/cli/index.ts`, completions or help to add one — the convention resolves it automatically.

| Verb | File | Reads or does | Writes anything? |
|------|------|---------------|------------------|
| backlog | `src/cli/fleet-backlog.ts` | Read-only triage of the open-PR merge backlog | no |
| bet-trace | `src/cli/fleet-bet-trace.ts` | Offline supervisor-command reconciliation; no dispatch or mutation authority | no |
| brains | `src/cli/fleet-brains.ts` | Read-only last-action view of each fleet brain from the dispatch-events tail; stale past 90 minutes, missing log is unknown | no |
| bus-thread | `src/cli/fleet-bus-thread.ts` | Reads retained live local context only; routing labels are not authenticated identities | no |
| canary-ladder | `src/cli/fleet-canary-ladder.ts` | Read-only report of which auto-merge rung each repo's recent merge outcomes compute on the canary enforce ladder | no |
| ci-failures | `src/cli/fleet-ci-failures.ts` | Reads CI failure groups from a repo, configurable repo and hours window | no |
| ci-nightly | `src/cli/fleet-ci-nightly.ts` | Reads CI nightly hotspots for a repo, configurable repo flag | no |
| class-share | `src/cli/fleet-class-share.ts` | Offline accounting only; never changes dispatch or merge authority | no |
| dead-heads | `src/cli/fleet-dead-heads.ts` | Read-only report; never edits queue state or launches jobs | no |
| dispatch-summary | `src/cli/fleet-dispatch-summary.ts` | Read-only dispatch intent rollup; never writes and never contacts a provider | no |
| dirty-landed | `src/cli/fleet-dirty-landed.ts` | Read-only landed / partly-landed / needs-recut / unknown class per open conflicting PR; scratch git objects in a temporary bare repo | no |
| disk | `src/cli/fleet-disk.ts` | Read-only disk-pressure view: free-GB trend from LEADER rows in the last 12 hours plus the ten largest folders under the runs dir; unread sources print unknown | no |
| drip | `src/cli/fleet-drip.ts` | Read-only open Phantom PRs vs the limit of 250, finished jobs waiting behind a `queue/run/<job>.phdrip` marker and the oldest marker age; unread sources print unknown | no |
| edit-collisions | `src/cli/fleet-edit-collisions.ts` | Reads job detail, changes, text and bus inbox for a job ID | no |
| grok-usage | `src/cli/fleet-grok-usage.ts` | Reads Grok usage metrics from a configured source | no |
| job-class-share | `src/cli/fleet-job-class-share.ts` | Offline accounting only; share of finished-job tokens by class per lane | no |
| job-read | `src/cli/fleet-job-read.ts` | Reads job detail, changes, text and bus inbox for a job ID | no |
| lane-models | `src/cli/fleet-lane-models.ts` | The effective model per lane and tier from models.json, cross-checked against the newest launch row in metrics/jobs.jsonl; read-only | no |
| lane-truth | `src/cli/fleet-lane-truth.ts` | Offline advisory only; never changes a hold or grants dispatch authority | no |
| filler-yield | `src/cli/fleet-filler-yield.ts` | Read-only per-repo yield of author-filler jobs (`RQ-…A…Q8`) from metrics/jobs.jsonl: launches, code-13 precheck skips, empty finishes, MERGED outcomes; red (exit 1) when skips are over half of 10+ rows; unread file prints unknown | no |
| launch-proof | `src/cli/fleet-launch-proof.ts` | Read one status snapshot and one live process table; never dispatch work | no |
| memory | `src/cli/fleet-memory.ts` | Read-only host memory view: memstat.json free/swap/disk plus .memguard2.json level and stopped ids | no |
| meter-drop | `src/cli/fleet-meter-drop.ts` | Read-only meter drop verdict from lane state and meter samples | no |
| real-supply | `src/cli/fleet-real-supply.ts` | Read-only live supply for the planner: Dependabot alerts, red scheduled suites and open issues across the seven repos, plus local registry↔docs drift signals | no |
| red-merges | `src/cli/fleet-red-merges.ts` | Read-only per-hour rollup of merges landed on red vs green checks per lane, from metrics/jobs.jsonl outcome rows joined to launches by job id; unread ledger prints unknown | no |
| runs-read | `src/cli/fleet-runs-read.ts` | Reads runs dir state, leader journal and parked queue | no |
| ship-gap | `src/cli/fleet-ship-gap.ts` | Read-only ship-gap report for the seven approved repos; drift past newest version tag | no |
| stray-slots | `src/cli/fleet-stray-slots.ts` | Read-only host evidence: one lost slot per finished job with leftover processes | no |
| supply | `src/cli/fleet-supply.ts` | Read-only per-batch, per-hour 24 h counts of launch, skipped_empty, precheck_skip, PR-opened and MERGED outcome rows from metrics/jobs.jsonl; unread file prints unknown | no |
| task-check | `src/cli/fleet-task-check.ts` | Read-only: says whether a job's batch had 3 or more skipped_empty or precheck_skip rows in 24 h (`likely_empty`); unreadable metrics print `known:false` | no |
| wait-jobs | `src/cli/fleet-wait-jobs.ts` | Waits for fleet jobs by ID, monitors publication status | no |
| workers | `src/cli/fleet-workers.ts` | Lists live workers, filterable by lane, repo and age; watch mode | no |

**Convention for adding a new verb.** Create `src/cli/fleet-<verb>.ts` exporting `cmdFleet<Verb>` (each dash-separated part title-cased and concatenated). The dispatcher in `resolveFleetSubcommand` resolves it automatically; no edits to `fleet.ts`, `index.ts`, completions or help are needed. Update this doc to keep it in sync.
