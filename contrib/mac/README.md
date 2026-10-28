# contrib/mac: Actions queue gate for the Mac bridge

When GitHub Actions is saturated (free plan, many queued runs), new bridge
PRs are opened as drafts labeled `queue-held` so they do not add CI load.
A reaper un-drafts them once the queue drains, P0 first. Coding lanes keep
running; only CI start is deferred.

## Files
- `queue-gate.sh`: sourced by the bridge `publish.sh`. Read-only
  `gh api repos/ashlrai/<r>/actions/runs?status=queued` across the core 7.
  Fails open: any gh error opens the PR normally with a warning.
- `queue-reaper.sh`: un-drafts `queue-held` PRs (`gh pr ready`) and removes
  the label. `--dry-run` prints only. Lock-protected and idempotent.
- `test-queue-gate.sh`: stubbed-gh tests. Run `bash contrib/mac/test-queue-gate.sh`.

## Hook into publish.sh (scripts/mac-bridge/publish.sh, from #970)
```sh
. "$(dirname "$0")/queue-gate.sh"
queue_gate_check
URL=$(gh pr create ... $QUEUE_GATE_FLAGS ...)
queue_gate_label "$URL" "$REPO"
```
Push to the fork is unchanged. Skip `gh pr merge --auto` when
`QUEUE_GATE_HELD=1`; arm it after the reaper readies the PR.

## Mac install (Masbot)
```sh
cp contrib/mac/queue-gate.sh contrib/mac/queue-reaper.sh ~/ashlr/mac-bridge/
chmod +x ~/ashlr/mac-bridge/queue-reaper.sh
~/ashlr/mac-bridge/queue-reaper.sh --dry-run   # sanity check
```
Env vars (all optional):
| var | default | meaning |
|---|---|---|
| `QUEUE_GATE_THRESHOLD` | 15 | queued runs above which PRs open as draft |
| `QUEUE_GATE_REPOS` | core 7 | repos counted and reaped |
| `QUEUE_REAPER_BATCH` | 3 | PRs readied per run |
| `QUEUE_REAPER_P0_EXTRA` | `ashlrai/locus#217` | extra P0 PRs (space separated) |
| `QUEUE_REAPER_STATE` | `~/.queue-reaper` | lock and P0 tracking |

P0 = title or label containing MEMORY, ALIVE or DRIVER (case-insensitive),
plus `QUEUE_REAPER_P0_EXTRA`. Non-P0 PRs wait while any P0 PR the reaper
readied still has pending or failing checks.

Cron (every 5 min):
```
*/5 * * * * $HOME/ashlr/mac-bridge/queue-reaper.sh >> $HOME/Library/Logs/queue-reaper.log 2>&1
```
Or launchd, `~/Library/LaunchAgents/ai.ashlr.queue-reaper.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.ashlr.queue-reaper</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>$HOME/ashlr/mac-bridge/queue-reaper.sh</string>
  </array>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>/tmp/queue-reaper.log</string>
  <key>StandardErrorPath</key><string>/tmp/queue-reaper.log</string>
</dict></plist>
```
Load with `launchctl load ~/Library/LaunchAgents/ai.ashlr.queue-reaper.plist`.
