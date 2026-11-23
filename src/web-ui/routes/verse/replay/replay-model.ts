import { readToolFacts } from '../chat/tool-semantics.js';
import { createReplaySanitizer, MAX_RECORDING_BYTES } from './replay-redaction.js';
export { MAX_RECORDING_BYTES } from './replay-redaction.js';

export const REPLAY_SCHEMA = 'phantom.run-replay.v1';
const MAX_EVENTS = 5_000;
const INVALID = 'Choose a complete, valid run recording (up to 2 MB).';

export interface ReplayStep {
  readonly seq: number;
  readonly at: string;
  readonly kind: 'message' | 'command' | 'diff' | 'output' | 'status';
  readonly label: string;
  readonly text: string;
}
export interface ReplayRecording {
  readonly title: string;
  readonly steps: readonly ReplayStep[];
}
export type ReplayResult = { ok: true; recording: ReplayRecording } | { ok: false; error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw new Error(INVALID); }

/** One finished turn. Sequence numbers, never host time or arrival order, define playback. */
export function decodeReplay(value: unknown): ReplayResult {
  return decodeTurn(value, value);
}

function decodeTurn(value: unknown, redactionContext: unknown): ReplayResult {
  try {
    if (!record(value) || value.schema !== REPLAY_SCHEMA || !Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_EVENTS) invalid();
    const supplied = value.sensitiveValues ?? (record(redactionContext) ? redactionContext.sensitiveValues : undefined);
    const scrub = createReplaySanitizer(redactionContext, supplied);
    const events = value.events.map((e) => {
      if (!record(e) || !Number.isSafeInteger(e.seq) || (e.seq as number) < 0 || typeof e.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(e.at) || !Number.isFinite(Date.parse(e.at)) || typeof e.type !== 'string' || typeof e.turnId !== 'string' || !e.turnId) invalid();
      return e;
    }).sort((a, b) => (a.seq as number) - (b.seq as number));
    const turnId = events[0]!.turnId;
    if (events[0]!.type !== 'user-message' || events.filter((e) => e.type === 'turn-started').length !== 1 || events.filter((e) => e.type === 'user-message').length !== 1) invalid();
    const startedAt = events.findIndex((e) => e.type === 'turn-started');
    if (events.slice(1, startedAt).some((e) => !['status', 'context', 'source'].includes(e.type as string))) invalid();
    if (events.some((e, i) => e.turnId !== turnId || i > 0 && e.seq === events[i - 1]!.seq)) invalid();
    const last = events.at(-1)!;
    if (last.type !== 'turn-done' && last.type !== 'cancelled') invalid();
    if (events.slice(0, -1).some((e) => e.type === 'turn-done' || e.type === 'cancelled' || e.type === 'history-truncated')) invalid();
    const calls = new Map<string, { name: string; input: unknown }>();
    const steps: ReplayStep[] = [];
    const hasFinalMessage = events.some((event) => event.type === 'assistant-message');
    for (const event of events) {
      let kind: ReplayStep['kind'] = 'status';
      let label = '';
      let body = '';
      const field = (key: string): string => {
        if (typeof event[key] !== 'string') invalid();
        return scrub.text(event[key] as string);
      };
      switch (event.type) {
        case 'user-message': case 'assistant-message':
          kind = 'message'; label = event.type === 'user-message' ? 'You' : 'Agent'; body = field('text'); break;
        case 'text-delta':
          if (hasFinalMessage) continue;
          kind = 'message'; label = 'Agent (partial response)'; body = field('text'); break;
        case 'tool-use': {
          if (typeof event.toolUseId !== 'string' || calls.has(event.toolUseId)) invalid();
          const name = field('name');
          const input = scrub.clean(event.input);
          calls.set(event.toolUseId, { name, input });
          const facts = readToolFacts({ name, input, result: null });
          kind = facts.diff ? 'diff' : facts.command ? 'command' : 'status';
          label = facts.diff ? 'Proposed changes' : facts.command ? 'Recorded command' : `Tool: ${name}`;
          body = facts.diff?.text ?? facts.command?.command ?? JSON.stringify(input ?? null, null, 2);
          break;
        }
        case 'tool-result': {
          if (typeof event.toolUseId !== 'string' || typeof event.isError !== 'boolean') invalid();
          const call = calls.get(event.toolUseId);
          if (!call) invalid();
          const output = field('output');
          const facts = readToolFacts({ ...call, result: { output, isError: event.isError } });
          kind = facts.diff?.origin === 'output' ? 'diff' : 'output';
          label = facts.failed ? 'Tool failed' : 'Recorded output';
          body = kind === 'diff' ? facts.diff!.text : output;
          calls.delete(event.toolUseId);
          break;
        }
        case 'turn-started': label = 'Run started'; break;
        case 'turn-done':
          if (typeof event.ok !== 'boolean' || event.ok && calls.size > 0) invalid();
          label = event.ok ? 'Run completed' : 'Run failed'; break;
        case 'cancelled': label = 'Run cancelled'; break;
        case 'error': label = 'Recorded error'; body = field('message'); break;
        case 'remote-status': label = 'Remote status'; body = field('message'); break;
        case 'remote-pr': label = 'Recorded pull request'; body = field('url'); break;
        // Stream deltas duplicate the final message; telemetry is not a replay action.
        case 'thinking': case 'thinking-delta': case 'thinking-progress':
        case 'progress': case 'usage': case 'context': case 'source': case 'compaction': case 'status': case 'recovered':
          continue;
        default: invalid();
      }
      // Reapply after derived text, including diff paths and synthetic captions.
      steps.push(Object.freeze({ seq: event.seq as number, at: new Date(event.at as string).toISOString(), kind, label: scrub.text(label), text: scrub.text(body) }));
    }
    return { ok: true, recording: Object.freeze({ title: scrub.text(typeof value.title === 'string' ? value.title : 'Finished agent run'), steps: Object.freeze(steps) }) };
  } catch {
    return { ok: false, error: INVALID };
  }
}

export function parseReplayJson(json: string): ReplayResult {
  if (new TextEncoder().encode(json).length > MAX_RECORDING_BYTES) return { ok: false, error: INVALID };
  try {
    const value: unknown = JSON.parse(json);
    if (record(value) && value.schema === undefined && record(value.session) && Array.isArray(value.events)) {
      if (value.events.length > MAX_EVENTS || !value.events.every((e) => record(e) && typeof e.type === 'string' && Number.isSafeInteger(e.seq) && (typeof e.turnId === 'string' || e.turnId === null))) invalid();
      // Native VerseSessionDetail exports need no conversion or additional endpoint.
      return latestReplay(value.events, typeof value.session.title === 'string' ? value.session.title : undefined, value);
    }
    return decodeReplay(value);
  } catch { return { ok: false, error: INVALID }; }
}

/** Freeze the latest finished turn; never include a subsequent running turn. */
export function replayFromEvents(events: readonly { type: string; turnId: string | null; seq: number }[], title?: string): ReplayResult {
  return latestReplay(events, title, { title, events });
}

function latestReplay(events: readonly { type: string; turnId: string | null; seq: number }[], title: string | undefined, redactionContext: unknown): ReplayResult {
  const seqs = new Set<number>();
  if (events.length > MAX_EVENTS || events.some((e) => {
    if (!record(e) || !Number.isSafeInteger(e.seq) || e.seq < 0 || seqs.has(e.seq)) return true;
    seqs.add(e.seq);
    return false;
  })) return { ok: false, error: INVALID };
  const terminal = events.filter((e) => e.type === 'turn-done' || e.type === 'cancelled').sort((a, b) => b.seq - a.seq)[0];
  if (!terminal) return { ok: false, error: 'Finish an agent run, or open a local recording.' };
  return decodeTurn({ schema: REPLAY_SCHEMA, title, events: events.filter((e) => e.turnId === terminal.turnId && e.seq <= terminal.seq) }, redactionContext);
}

export function seekReplay(recording: ReplayRecording, position: number): readonly ReplayStep[] {
  const cursor = Number.isFinite(position) ? Math.max(0, Math.min(recording.steps.length, Math.trunc(position))) : 0;
  return recording.steps.slice(0, cursor);
}
