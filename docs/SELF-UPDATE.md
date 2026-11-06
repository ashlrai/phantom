# Self-Update

Phantom's source-checkout self-update keeps your local Hub up to date with `origin/master` when you run as a checked-out repo.  The Ops API (`GET /api/verse/ops/self-update`) reports the state; POSTing `{action:"apply"}` runs it.

## Where it shows

- **Settings ▸ Updates** row: status headline, "Fast-forward ready / Needs local changes" readiness, "Update now" button.
- **About pane** (`/settings/about`): running commit, committed time, origin, last fetch, process uptime, last apply outcome.
- **Gear badge** (topbar 🔔): unread count, urgent red overlay, accessible name `Notifications, N open, M urgent`.
- **Bell notifications**: five update IDs from `deriveUpdateNotifications.ts` — `update-ready`, `update-held`, `update-failed`, `update-restart-needed`, `update-applied`.

## The reading

Every field of `OpsSelfUpdateV1` from `GET /api/verse/ops/self-update`:

| Field | Meaning | Example |
|-------|---------|---------|
| `v` | Schema version | `1` |
| `generatedAt` | ISO timestamp when this snapshot was produced | `"2025-10-31T12:00:00.000Z"` |
| `sourceState` | `"healthy"`, `"degraded"`, or `"unavailable"` | `"healthy"` |
| `installedVersion` | package.json version string, or `null` | `"3.2.1"` |
| `repoRoot` | `true` when this Hub runs inside a git checkout | `true` |
| `headSha` | Current local commit hash, or `null` | `"a1b2c3d4…"` |
| `processHeadSha` | SHA when this Hub process started (null = never updated since boot) | `"a1b2c3d4…"` |
| `headAt` | ISO commit date of `headSha`, or `null` | `"2025-10-30T08:00:00.000Z"` |
| `originSha` | Latest `origin/master` commit, or `null` | `"e5f6a7b8…"` |
| `branch` | Branch name tracked by origin, or `null` | `"master"` |
| `behind` | Number of commits behind origin (`null` = unknown) | `3` |
| `ahead` | Number of commits ahead (`null` = unknown) | `0` |
| `dirty` | Whether the working tree has uncommitted changes (`null` = unknown) | `false` |
| `lastFetchAt` | Timestamp of last `git fetch origin`, or `null` | `"2025-10-31T11:50:00.000Z"` |
| `processStartedAt` | ISO timestamp when this Hub process launched | `"2025-10-31T09:00:00.000Z"` |
| `uptimeSeconds` | Seconds since process start | `7200` |
| `pid` | Operating-system process ID | `12345` |
| `canFastForward` | `true` if origin is a provable fast-forward (`null` = unknown) | `true` |

## lastApply

The last applied update (loaded from `<ashlrHome>/verse/self-update-last.json`):

| Field | Meaning |
|-------|---------|
| `outcome` | `"updated"`, `"already-current"`, `"refused"`, or `"failed"` |
| `reason` | Why it stopped, or `null` |
| `startedAt` / `finishedAt` | ISO start and end timestamps |
| `fromCommit` / `toCommit` | 7+ char hex commit range, or `null` |
| `restartRequired` | `true` when outcome was `"updated"` |
| `restartMode` | `"sidecar-supervised"` or `"manual"` |

## What apply does

1. **Clean tree**: `git status --porcelain` must be empty (else `refused` · "dirty tree").
2. **Fetch origin master**: `git fetch origin master` (60 s timeout).
3. **Fast-forward proof**: compare `HEAD` vs `origin/master` — equal → `"already-current"`, not-ancestor → `refused` · "diverged", valid ancestor → proceed.
4. **Run updater**: `<nodeBin> <cliEntry> update --json` (10 min timeout).
5. **Persist result** (tmp + rename) at `<ashlr home>/verse/self-update-last.json`.

## Restart

- **`sidecar-supervised`** — the desktop app's supervisor restarts the Hub after our SIGTERM (backoff 1 s → 30 s, max 5 exits per 10 min). Triggered when `ASHLR_WEB_PUBLIC` env is set or `--desktop-token-handoff` is on argv.
- **`manual`** — quit and reopen Phantom yourself. The default when neither marker is present.
- Chosen by `detectRestartMode(process.env, process.argv)` at apply completion time.

## When it refuses

| Condition | Outcome | What to do |
|-----------|---------|-------------|
| Dirty tree (`git status --porcelain` non-empty) | `refused` · "dirty tree" | Commit or stash local changes, then retry. |
| Diverged (`ahead > 0` — HEAD not an ancestor of origin/master) | `refused` · "diverged" | Rebase or merge local commits onto origin/master first. |
| Not a git checkout (`repoRoot` is false / no `.git`) | Status reports `"unavailable"` | Install from a published release or run `npm install` in the checkout. |

[docs/SELF-HOSTING.md](SELF-HOSTING.md) · [docs/QUICKSTART.md](QUICKSTART.md)
