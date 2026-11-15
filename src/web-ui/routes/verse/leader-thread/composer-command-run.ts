/**
 * routes/verse/leader-thread/composer-command-run.ts — runs a parsed Leader
 * composer command against injected action functions (the same client calls
 * the app's buttons use; no new endpoints) and returns the system line the
 * thread shows. It never throws: a failure becomes the line.
 *
 * Writes that succeed also post one short inbox note ("[composer] /pause:
 * done") so the leaders see what Mason did. /drop, /open and /help are local, and
 * /status is read-only, so they post nothing.
 */
import { pauseFleet, resumeFleet } from '../../../data/mutations.js';
import { describeControlError } from '../autonomy/use-guarded-action.js';
import type { ConfirmSpec } from '../command/actions.js';
import { openDockPane } from '../dock/dock-store.js';
import { postJobStop, stopOutcomeText, type JobStopResult } from '../fleet-job-log/job-stop-action.js';
import { postLaneHold, postReleaseHold } from '../fleet-lanes/lane-hold-release.js';
import { suggestId, type DropJobDraft } from '../fleet-queue/drop-job-model.js';
import { openDropJobSheet } from '../fleet-queue/drop-job-sheet-store.js';
import { normalizePaneId } from '../shell/dock-catalog.js';
import { isLaneTargets } from '../ops/lane-targets-model.js';
import { commandArgError, helpLine, holdArgs, type ComposerCommandName } from './composer-commands.js';
import { sendLeaderInboxMessage } from './leader-inbox-data.js';
import { fetchLeaderStatusNow } from './leader-status-now.js';

export const COMPOSER_RELEASE_REASON = 'released from Leader composer';
export const COMPOSER_HOLD_REASON = 'held from Leader composer';

export interface ComposerCommand { name: ComposerCommandName; arg: string }

export interface ComposerCommandDeps {
  pauseFleet: () => Promise<void>;
  resumeFleet: () => Promise<void>;
  releaseHold: (lane: string, reason: string) => Promise<unknown>;
  holdLane: (lane: string, minutes: number, reason: string) => Promise<unknown>;
  stopJob: (id: string) => Promise<JobStopResult>;
  openPane: (id: string) => void;
  openDropSheet: (seed: DropJobDraft) => 'seeded' | 'kept';
  statusNow: () => Promise<string | null>;
  postNote: (text: string) => Promise<void>;
  now: () => number;
}

export const liveComposerDeps: ComposerCommandDeps = {
  pauseFleet,
  resumeFleet,
  releaseHold: postReleaseHold,
  holdLane: postLaneHold,
  stopJob: postJobStop,
  openPane: openDockPane,
  openDropSheet: seed => {
    const outcome = openDropJobSheet(seed);
    // 'kept' leaves the unsent draft's sheet alone, like the other seeders.
    if (outcome === 'seeded') openDockPane('fleet-queue');
    return outcome;
  },
  statusNow: fetchLeaderStatusNow,
  postNote: sendLeaderInboxMessage,
  now: Date.now,
};

/**
 * How a command must be gated before it runs: null runs it locally (no token,
 * no confirm); otherwise it needs the mutation hold and, when `confirm` is
 * set, the confirm its button already asks for. The release buttons have none.
 */
export function commandGate(command: ComposerCommand): { reason: string; confirm: ConfirmSpec | null } | null {
  if (commandArgError(command)) return null;
  switch (command.name) {
    case 'pause': return { reason: 'Pausing the fleet requires the mutation token.', confirm: {
      title: 'Pause the fleet?',
      body: 'This engages the global kill switch. Autonomous dispatch halts fleet-wide until explicitly resumed.',
      confirmLabel: 'Yes, pause',
      destructive: true,
    } };
    case 'resume': return { reason: 'Resuming the fleet requires the mutation token.', confirm: {
      title: 'Resume the fleet?',
      body: 'This clears the global kill switch. Autonomous dispatch will resume across the fleet.',
      confirmLabel: 'Yes, resume',
    } };
    case 'release': return { reason: 'Releasing a lane hold requires the mutation token.', confirm: null };
    // Holding is the safe direction — like release it asks for no confirm.
    case 'hold': return { reason: 'Holding a lane requires the mutation token.', confirm: null };
    case 'stop': return { reason: 'Stopping a job requires the mutation token.', confirm: {
      title: `Stop ${command.arg}?`,
      body: 'This stops the job’s running processes.',
      confirmLabel: 'Yes, stop',
      destructive: true,
    } };
    default: return null;
  }
}

/** Runs the write and returns [system line, inbox outcome word]. */
async function write(command: ComposerCommand, deps: Omit<ComposerCommandDeps, 'openPane'>): Promise<[string, string]> {
  switch (command.name) {
    case 'pause':
      await deps.pauseFleet();
      return ['Paused the fleet', 'done'];
    case 'resume':
      await deps.resumeFleet();
      return ['Resumed the fleet', 'done'];
    case 'release': {
      const result = await deps.releaseHold(command.arg, COMPOSER_RELEASE_REASON);
      // Same confirmation the Verse composer's /release reads off the reply.
      const row = isLaneTargets(result) ? result.lanes.find(item => item.lane === command.arg) : undefined;
      if (!row || row.held) throw new Error('The server did not confirm the lane release.');
      return [`Released ${command.arg}`, 'done'];
    }
    case 'hold': {
      // commandArgError already ran, so the argument always splits here.
      const parts = holdArgs(command.arg);
      if (!parts) throw new Error('The server did not confirm the lane hold.');
      const result = await deps.holdLane(parts.lane, parts.minutes, COMPOSER_HOLD_REASON);
      const row = isLaneTargets(result) ? result.lanes.find(item => item.lane === parts.lane) : undefined;
      if (!row || !row.held) throw new Error('The server did not confirm the lane hold.');
      return [`Held ${parts.lane} for ${parts.minutes} min`, 'done'];
    }
    default: {
      const result = await deps.stopJob(command.arg);
      const outcome = stopOutcomeText(result);
      return [`Stop ${command.arg}: ${outcome}`, outcome];
    }
  }
}

export function runComposerCommand(command: ComposerCommand, deps: ComposerCommandDeps): Promise<string>;
export function runComposerCommand(command: { name: Exclude<ComposerCommandName, 'open'>; arg: string }, deps: Omit<ComposerCommandDeps, 'openPane'>): Promise<string>;
export async function runComposerCommand(command: ComposerCommand, deps: Omit<ComposerCommandDeps, 'openPane'> & Partial<Pick<ComposerCommandDeps, 'openPane'>>): Promise<string> {
  const argError = commandArgError(command);
  if (argError) return argError;
  if (command.name === 'help') return helpLine();
  if (command.name === 'open') {
    const id = normalizePaneId(command.arg)!;
    deps.openPane!(id);
    return `Opened ${id}.`;
  }
  if (command.name === 'status') {
    // Read only: no token gate, no inbox note.
    try {
      return await deps.statusNow() ?? 'Status is unavailable right now.';
    } catch (error) {
      return `/status failed: ${describeControlError(error)}`;
    }
  }
  if (command.name === 'drop') {
    const outcome = deps.openDropSheet({ id: suggestId(command.arg, deps.now()), lane: 'codex-personal', tier: 'mid', body: command.arg });
    return outcome === 'seeded'
      ? 'Opened the drop-job sheet with your text; nothing is queued until you submit it.'
      : 'You have an unsent draft; the /drop text was not applied.';
  }
  const label = `/${command.name}${command.arg ? ` ${command.arg}` : ''}`;
  let line: string;
  let outcome: string;
  try {
    [line, outcome] = await write(command, deps);
  } catch (error) {
    return `${label} failed: ${describeControlError(error)}`;
  }
  try {
    await deps.postNote(`[composer] ${label}: ${outcome}`);
  } catch (error) {
    return `${line} (inbox note failed: ${describeControlError(error)})`;
  }
  return line;
}
