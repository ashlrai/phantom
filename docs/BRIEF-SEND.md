# Fleet brief-send: morning and overnight briefs

`phm fleet brief-send` sends a short fleet summary to your email and Telegram
channels twice a day: a morning brief at 7:30 ET and an overnight brief at
22:30 ET. Each brief opens with a needs-you list of at most 5 items, then the
usual status counts.

Without `--apply` it only prints what it would send. The briefs go to you, the
owner, on channels you already configured. Nothing goes to a third party.

## What you get

```text
Needs you: 3 (overnight)
- Review: weekly dependency refresh
- Approve release note for the docs lane
- Merge request waiting on you
<fleet status counts>
```

The morning brief has no label on the first line. The list holds the owner
ledger items first, then automation reviews. Pending drafts are listed too
when the drafts lane (RQ-COS-DRAFTS-1) supplies them; until it does, that
section is skipped without error. The whole text stays under 1200 characters.

## Budget

Each slot has its own local-day budget (America/New_York): a channel gets at
most one morning brief and one overnight brief per day. A failed send does not
use the budget, so the next run retries. With no `--slot`, the latest slot
whose time has passed today is used, and before the morning time nothing is
due (`slot-not-due`).

## Change the times

Pass `--morning-at HH:MM` and `--overnight-at HH:MM`, or set
`ASHLR_BRIEF_MORNING_AT` and `ASHLR_BRIEF_OVERNIGHT_AT`. A value that is not
`HH:MM` falls back to the default.

## Copy-paste

```bash
phm fleet brief-send --json                     # dry run, plan as JSON
phm fleet brief-send --slot overnight --apply   # send the overnight brief
phm fleet brief-send --morning-at 08:00 --channel telegram --apply
```

`--json` prints `{ apply, slot, day, entries, results? }`. Each entry is
`{ channel, send: true, text }` or `{ channel, send: false, reason }` with
reason `already-sent-today`, `not-configured`, `status-unavailable` or
`slot-not-due`. No token, chat id or address is ever printed.
