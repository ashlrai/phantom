/**
 * routes/verse/mobile/mobile-switches-model.ts — the Mac's runs-directory
 * switch files as rows for the phone's "Switches on the Mac" card. Pure: the
 * component feeds it the fleet-runs snapshot (`switches`: the file names the
 * Mac observed) and the control route's own list (when this build has that
 * route — the card is writable then), and it answers each known switch's
 * on/off — or null when neither source can honestly say.
 *
 * Honesty: a file name in `switches` is a positive observation, so it is
 * "on" in every state the snapshot can reach; "off" is only claimed when the
 * runs-dir read was healthy. A missing or unlanded runs source says nothing.
 */
import type { Tone } from './ui-parts.js';

export type SwitchId = 'HOLD' | 'PAUSE' | 'ORCH_OFF' | 'OPUS_LEADER_OFF' | 'PUBLISH_HOLD' | 'QUEUE_DISABLE';

export interface KnownSwitch {
  id: SwitchId;
  /** The row's verb: what the switch does while it is on. */
  label: string;
  /** One sentence on what the switch changes on the Mac. */
  meaning: string;
  /** Badge tone while the switch is on. */
  tone: Tone;
}

/** Order the spec asks the card to show; ids match core/fleet/runs-switches.ts. */
export const KNOWN_SWITCHES: readonly KnownSwitch[] = [
  { id: 'HOLD', label: 'Saved lane holds', meaning: 'Individual lane holds are preserved. Disable the queue to pause all new launches.', tone: 'warning' },
  { id: 'PAUSE', label: 'Pause workers', meaning: 'Running jobs finish; nothing new starts.', tone: 'warning' },
  { id: 'ORCH_OFF', label: 'Stop scheduled planning passes', meaning: 'Scheduled planning passes pause on every login; workers keep running. The Leader uses its own schedule.', tone: 'warning' },
  { id: 'OPUS_LEADER_OFF', label: 'Stop the Leader planning loop', meaning: 'The supplementary hourly Leader loop pauses. The Leader can use any available provider.', tone: 'warning' },
  { id: 'PUBLISH_HOLD', label: 'Hold publishing', meaning: 'Finished jobs are not published as pull requests.', tone: 'warning' },
  { id: 'QUEUE_DISABLE', label: 'Disable the queue', meaning: 'Queued jobs are not claimed.', tone: 'danger' },
];

/** File name in the snapshot → switch id (queue/DISABLE nests under the queue dir). */
const FILE_TO_ID: Readonly<Record<string, SwitchId>> = {
  HOLD: 'HOLD',
  PAUSE: 'PAUSE',
  ORCH_OFF: 'ORCH_OFF',
  OPUS_LEADER_OFF: 'OPUS_LEADER_OFF',
  PUBLISH_HOLD: 'PUBLISH_HOLD',
  'queue/DISABLE': 'QUEUE_DISABLE',
};

export interface SwitchRow extends KnownSwitch {
  /** null = neither source could say (rendered "—", never "off"). */
  on: boolean | null;
}

export type SwitchSourceState = 'healthy' | 'degraded' | 'missing' | 'unknown';

export interface SwitchesView {
  rows: SwitchRow[];
  /** The control route answered this build — its POST path exists too. */
  writable: boolean;
  sourceState: SwitchSourceState;
}

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The snapshot's contribution: which switches its `switches` names prove on,
 * whether an absent name may be called off, and how much to trust the read.
 * sources.runsDir 'missing'/'not-landed' says nothing at all — not even off.
 */
function snapshotRead(snapshot: unknown): { on(id: SwitchId): boolean | null; state: SwitchSourceState } | null {
  if (!record(snapshot) || !Array.isArray(snapshot.switches) || !snapshot.switches.every((n) => typeof n === 'string')) return null;
  const present = new Set<SwitchId>();
  for (const name of snapshot.switches as string[]) {
    const id = FILE_TO_ID[name];
    if (id) present.add(id);
  }
  const sources = record(snapshot.sources) ? snapshot.sources : {};
  const runsDir = typeof sources.runsDir === 'string' ? sources.runsDir : '';
  const state: SwitchSourceState = runsDir === 'healthy' ? 'healthy'
    : runsDir === 'degraded' ? 'degraded'
      : runsDir === 'missing' || runsDir === 'not-landed' ? 'missing'
        : 'unknown';
  if (state === 'missing') return { on: () => null, state };
  return { on: (id) => (present.has(id) ? true : state === 'healthy' ? false : null), state };
}

/**
 * The control route's read (RunsSwitchesV1): every row must carry its own
 * id and a boolean on — a body that fails that is not the route we know, so
 * the card stays read-only rather than guess from it.
 */
function controlRead(control: unknown): { states: ReadonlyMap<SwitchId, boolean>; state: SwitchSourceState } | null {
  if (!record(control) || control.v !== 1 || !Array.isArray(control.switches)) return null;
  const states = new Map<SwitchId, boolean>();
  for (const row of control.switches) {
    if (!record(row) || typeof row.id !== 'string' || typeof row.on !== 'boolean') return null;
    if (KNOWN_SWITCHES.some((k) => k.id === row.id)) states.set(row.id as SwitchId, row.on);
  }
  const raw = control.sourceState;
  const state: SwitchSourceState = raw === 'healthy' || raw === 'degraded' || raw === 'missing' ? raw : 'unknown';
  return { states, state };
}

/**
 * Merge the two readings. The control route is the authority (it returns the
 * read-back after every write); the snapshot fills rows the route does not
 * list and carries the whole card when the route is not in this build.
 */
export function readSwitches(snapshot: unknown, control: unknown | null): SwitchesView {
  const ctrl = controlRead(control);
  const snap = snapshotRead(snapshot);
  const rows = KNOWN_SWITCHES.map((k): SwitchRow => {
    const on = ctrl?.states.has(k.id) ? ctrl.states.get(k.id)! : snap ? snap.on(k.id) : null;
    return { ...k, on };
  });
  return { rows, writable: ctrl !== null, sourceState: ctrl?.state ?? snap?.state ?? 'unknown' };
}

export interface SwitchConfirm {
  /** Sheet title: the question. */
  title: string;
  /** Sheet body: what changes on the Mac. */
  body: string;
  /** The confirm button. */
  confirmLabel: string;
  /** Success toast once the write lands. */
  done: string;
}

const CONFIRM: Readonly<Record<Exclude<SwitchId, 'HOLD'>, { on: SwitchConfirm; off: SwitchConfirm }>> = {
  PAUSE: {
    on: { title: 'Pause workers on your Mac?', body: 'Running jobs finish; nothing new starts.', confirmLabel: 'Pause workers', done: 'Workers paused.' },
    off: { title: 'Resume workers on your Mac?', body: 'New jobs may start again.', confirmLabel: 'Resume workers', done: 'Workers resumed.' },
  },
  ORCH_OFF: {
    on: { title: 'Stop scheduled planning passes on your Mac?', body: 'Scheduled planning passes pause on every login; workers keep running. The Leader uses its own schedule.', confirmLabel: 'Stop scheduled planning passes', done: 'Scheduled planning passes stopped.' },
    off: { title: 'Resume scheduled planning passes on your Mac?', body: 'Scheduled planning passes may run again on any login. The Leader uses its own schedule.', confirmLabel: 'Resume scheduled planning passes', done: 'Scheduled planning passes resumed.' },
  },
  OPUS_LEADER_OFF: {
    on: { title: 'Stop the Leader planning loop on your Mac?', body: 'The supplementary hourly Leader loop pauses. The Leader can use any available provider.', confirmLabel: 'Stop the Leader planning loop', done: 'Leader planning loop stopped.' },
    off: { title: 'Resume the Leader planning loop on your Mac?', body: 'The supplementary hourly Leader loop may run again. The Leader can use any available provider.', confirmLabel: 'Resume the Leader planning loop', done: 'Leader planning loop resumed.' },
  },
  PUBLISH_HOLD: {
    on: { title: 'Hold publishing on your Mac?', body: 'Finished jobs are not published as pull requests.', confirmLabel: 'Hold publishing', done: 'Publishing held.' },
    off: { title: 'Resume publishing on your Mac?', body: 'Finished jobs may be published as pull requests again.', confirmLabel: 'Resume publishing', done: 'Publishing resumed.' },
  },
  QUEUE_DISABLE: {
    on: { title: 'Disable the queue on your Mac?', body: 'Queued jobs are not claimed until it is enabled again.', confirmLabel: 'Disable the queue', done: 'Queue disabled.' },
    off: { title: 'Enable the queue on your Mac?', body: 'Queued jobs may be claimed again.', confirmLabel: 'Enable the queue', done: 'Queue enabled.' },
  },
};

/** The sheet's wording for flipping `id` to `on`. */
export function confirmText(id: SwitchId, on: boolean): SwitchConfirm {
  if (id === 'HOLD') throw new Error('Saved lane holds are read-only here.');
  return (CONFIRM[id] ?? CONFIRM.PAUSE)[on ? 'on' : 'off'];
}
