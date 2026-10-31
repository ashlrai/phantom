# Phantom glossary

Phantom's fleet uses a shared vocabulary so every leader, worker, and the desktop console talk about the same things.

## Job

One unit of work for a worker, written as a prompt file; a job has one concern and ends in a pull request.

## Lane

A pool of worker slots backed by one provider or account (for example devin, codex-local, claude); each lane has a running count and a target.

## Tier

The model size a job asks for within a lane: fast, mid, work or frontier.

## Held lane

A lane that will not launch new jobs because its usage limit is reached or a hold was set by hand.

## Queue

The list of jobs waiting for a free slot, ordered by readiness.

## Worker

One running agent session that owns one job in its own git worktree.

## Bridge PR

The pull request a worker's uncommitted changes become; its title names the job.

## BRIDGE_NOTES.md

The hand-off file a worker writes at the worktree root: summary, commands run, test counts, net lines changed.

## Merge Gate

The required CI check that runs the full lint, typecheck and tests before a bridge PR can merge.

## Runs directory

The local folder where the fleet records lanes, workers, switches and events; the desktop console reads it live.

## Switch

A file whose presence pauses dispatch (a HOLD switch) or changes fleet behaviour; the desktop console shows which switches are on.

## Inbox

The shared file where Mason's prompts and interjections land from any channel, read by every leader and agent.

## Interjection

A message from Mason that steers running work without stopping it.

## Agent bus

The shared event stream agents read and write to coordinate; shown in the desktop console.

## Pane

One dockable view in the desktop console (lanes, merges, usage, worker log, and so on).

## Leader

A planning agent that writes jobs; workers build them.

See also: [CLI reference](./CLI-REFERENCE.md), [Architecture overview](./ARCHITECTURE.md).
