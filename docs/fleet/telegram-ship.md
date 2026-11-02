# Ship a Phantom release from Telegram

Send `/ship` in the configured private Telegram chat.
Phantom replies with the open release PR and its checks.
Only the configured owner can use this command.
If the PR is green and mergeable, it is armed for 10 minutes.
Reply `/ship confirm` within that window to request the merge.
Confirmation is single use, even if the request fails.
Phantom checks the PR again and refuses changed or blocked releases.
If the window expires, send `/ship` again to start over.
Merging the release PR triggers release-please release tagging.
The desktop self-update picks up the release on its next check.
