# Outcome learning

Status: source-complete. The dispatch log is the memory. There is no operator
setting for the weights, the exploration rate, or the failure threshold.

## What it records

`learnOutcomes` reads a dispatch event log. A finished job is an `ASSIGN` or
`LAUNCH` (with resource, model, job type, and repo) followed by an `OUTCOME`
(`merged`, `closed`, `dirty`, or `fixup`, plus usage, optional minutes, and
`breakage=0|1`). The same facts may arrive as JSON lines. Legacy
`LAUNCH job repo lane tier` rows are ignored. For each
(resource, model, job type, repo) the view reports merge rate, time to merge,
usage, and breakage rate.

## How it routes

`routeLearnedJob` draws a Thompson sample from a Beta success posterior and a
Gamma cheapness posterior. Success is a merge that did not break main.
Cheapness is the inverse of usage, so the draw favors the cheapest resource
that ships. A cold resource still wins some draws; that is the exploration.

When a resource's observed time to merge is longer than the time left before
its allowance resets, it cannot take the job. Among resources that can finish,
one whose allowance resets sooner gets a higher score, which is the
usage-before-reset balance. A critical job never returns `wait`: if something
can take it now, it is sent there; if nothing can, the action is `nowhere`.

The plain-language reason names the constraint that decided the assignment,
for example `Sent to Devin because CMP Codex resets in 40 min with 5% left.`

`learnedSeatPenalty` turns the same posterior means into seat-router penalties.
Omitting the penalty leaves `routeSeat` unchanged.

## Improvement jobs

A failure pattern becomes an improvement job when it has happened at least
three times and, for a low merge rate, good merges are the minority. The jobs
are data. This module does not enqueue them, spend, or merge.

## Surfaces

`phm fleet outcomes` and `phm fleet outcomes route` print the view. `--json`
is the same object the desktop imports from
`desktop/outcome-learning-view.ts`.
