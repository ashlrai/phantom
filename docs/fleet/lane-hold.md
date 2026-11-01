# fleet lane-hold — bounded, self-expiring lane hold

`ashlr fleet lane-hold <lane> --minutes <n> --reason <text> [--runs-dir <abs>] [--json]`
places a hold on a lane through the same guarded slots.json temp+rename path
releaseLaneHold uses — nobody hand-edits queue/slots.json when a lane is
burning jobs on dead credentials.

- `--minutes` is required, an integer 1..1440: a Phantom hold always
  expires. dispatchd enforces `held_until`; the cap is 24 h.
- `--reason` is required, printable ASCII, at most 120 chars. It lands in
  `held_reason`, the lane-target-changes.log audit line and the
  dispatch-events.log narration.
- `held_by` stamps `phantom <changed-by> <iso>` and may be refreshed. A row
  held by anyone else — `held_by` not `autobackoff`, not `phantom…` — is
  refused `manual-hold`: a hold a person placed is never overwritten.
- releaseLaneHold still treats a phantom hold as manual; a follow-up
  relaxes that once runs-lane-hold.ts is free.
