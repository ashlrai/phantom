/**
 * RQ-PHX-SESSIONINTERJECT — per-session operator guidance, pure contract
 * slice (first concern of the #3297 recut):
 *   - the per-lane delivery strategy table (data, not an enum)
 *   - the 4 KiB message cap and the path-traversal job id guard
 *   - the ack state machine: queued -> delivered at turn N | requeued
 *   - the line fold that turns the JSONL file into per-message state
 * The writer, readers and /api/fleet/** routes land with the
 * session-guidance-io slice; their coverage returns to this file then.
 */
import { describe, expect, it } from 'vitest';
import {
  capGuidanceText,
  foldGuidanceLines,
  guidanceAckTransition,
  guidanceJobFromPath,
  isGuidanceJobId,
  strategyForLane,
  GUIDANCE_TEXT_MAX_BYTES,
  type GuidanceAckState,
} from '../src/core/fleet/session-guidance.js';

const JOB = 'RQ-PHX-TEST-1';

// ---------------------------------------------------------------------------
// Strategy selection per lane
// ---------------------------------------------------------------------------

describe('strategyForLane', () => {
  it.each([
    ['agy', 'stream-json-inject'],
    ['agy-eu', 'stream-json-inject'],
    ['claude', 'resume-followup'],
    ['claude-api', 'resume-followup'],
    ['zai', 'resume-followup'],
    ['codex-cmp', 'resume'],
    ['codex-personal', 'resume'],
    ['codex-local', 'resume'],
    ['grok', 'resume'],
    ['grok-2', 'resume'],
    ['devin', 'requeue'],
    ['local', 'requeue'],
    ['gemini', 'requeue'],
    ['cursor', 'requeue'],
    ['something-new', 'requeue'],
    ['', 'requeue'],
  ])('maps lane %s to %s', (lane, kind) => {
    expect(strategyForLane(lane).kind).toBe(kind);
    expect(strategyForLane(lane).label.length).toBeGreaterThan(0);
    expect(strategyForLane(lane).mechanism.length).toBeGreaterThan(0);
  });

  it('normalizes case and whitespace, and nulls to requeue', () => {
    expect(strategyForLane(' Claude ').kind).toBe('resume-followup');
    expect(strategyForLane(null).kind).toBe('requeue');
    expect(strategyForLane(undefined).kind).toBe('requeue');
    expect(strategyForLane(null).family).toBe('unknown');
  });

  it('keeps lane names as data: codex-* prefixes resolve without an enum', () => {
    expect(strategyForLane('codex-future-lane').kind).toBe('resume');
    expect(strategyForLane('claude-sonnet-x').kind).toBe('resume-followup');
  });
});

// ---------------------------------------------------------------------------
// The 4 KiB cap and the job id guard
// ---------------------------------------------------------------------------

describe('capGuidanceText', () => {
  it('passes short text through unchanged', () => {
    expect(capGuidanceText('hello')).toEqual({ text: 'hello', truncated: false });
  });

  it('caps at GUIDANCE_TEXT_MAX_BYTES without splitting a multibyte character', () => {
    const text = 'é'.repeat(3_000); // 6,000 bytes of UTF-8
    const capped = capGuidanceText(text);
    expect(capped.truncated).toBe(true);
    const bytes = Buffer.byteLength(capped.text, 'utf8');
    expect(bytes).toBeLessThanOrEqual(GUIDANCE_TEXT_MAX_BYTES);
    expect(bytes).toBe(GUIDANCE_TEXT_MAX_BYTES); // é is 2 bytes; the cap lands exactly
    expect(capped.text.endsWith('�')).toBe(false);
    expect(() => Buffer.from(capped.text, 'utf8')).not.toThrow();
  });

  it('drops a leading multibyte tail cleanly when the cut falls inside it', () => {
    const text = 'a'.repeat(GUIDANCE_TEXT_MAX_BYTES - 1) + '€'; // 3-byte char straddling the cap
    const capped = capGuidanceText(text);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('a'.repeat(GUIDANCE_TEXT_MAX_BYTES - 1));
  });
});

describe('isGuidanceJobId / guidanceJobFromPath', () => {
  it.each([JOB, 'rq-1', 'A.b_c-d'])('accepts %s', (id) => expect(isGuidanceJobId(id)).toBe(true));
  it.each(['../etc', 'a/b', 'a\\b', 'a..b', '..', '', 'x', 'ab', 'job name', 'job\nname', 'job%2e%2e'])(
    'rejects %j', (id) => expect(isGuidanceJobId(id)).toBe(false));
  it('rejects an 81-char id', () => expect(isGuidanceJobId('a'.repeat(81))).toBe(false));
  it('parses the route path and refuses traversal encodings', () => {
    expect(guidanceJobFromPath(`/api/fleet/sessions/${JOB}/guidance`)).toBe(JOB);
    expect(guidanceJobFromPath('/api/fleet/sessions/..%2Fetc/guidance')).toBe(null);
    expect(guidanceJobFromPath('/api/fleet/sessions/a%2Fb/guidance')).toBe(null);
    expect(guidanceJobFromPath('/api/fleet/sessions/%E0%A4%A/guidance')).toBe(null); // malformed percent-encoding
    expect(guidanceJobFromPath('/api/fleet/sessions//guidance')).toBe(null);
    expect(guidanceJobFromPath('/api/fleet/guidance')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The ack state machine
// ---------------------------------------------------------------------------

const guidanceLine = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, type: 'guidance', id, job: JOB, at: '2026-11-03T19:31:00.000Z', source: 'test', lane: 'claude', tier: 'work', strategy: 'resume-followup', text: `note ${id}`, truncated: false, ...extra });

describe('guidanceAckTransition', () => {
  it.each<[GuidanceAckState, { state: 'delivered' | 'requeued'; turn: number | null }, GuidanceAckState | null]>([
    ['queued', { state: 'delivered', turn: 3 }, 'delivered'],
    ['queued', { state: 'delivered', turn: 0 }, 'delivered'],
    ['queued', { state: 'requeued', turn: null }, 'requeued'],
    ['queued', { state: 'delivered', turn: null }, null],   // delivered must name a turn
    ['queued', { state: 'delivered', turn: -1 }, null],
    ['delivered', { state: 'requeued', turn: null }, null], // terminal
    ['delivered', { state: 'delivered', turn: 9 }, null],
    ['requeued', { state: 'delivered', turn: 1 }, null],
  ])('%s + %j -> %s', (state, ack, next) => {
    expect(guidanceAckTransition(state, ack)).toBe(next);
  });
});

describe('foldGuidanceLines', () => {
  it('marks an unacked message queued', () => {
    const fold = foldGuidanceLines([guidanceLine('g1')]);
    expect(fold.entries).toHaveLength(1);
    expect(fold.entries[0]).toMatchObject({ id: 'g1', state: 'queued', turn: null, requeueTo: null });
    expect(fold.badLines).toBe(0);
  });

  it('delivered ack lands the turn', () => {
    const fold = foldGuidanceLines([
      guidanceLine('g1'),
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', at: '2026-11-03T19:32:00.000Z', state: 'delivered', turn: 4 }),
    ]);
    expect(fold.entries[0]).toMatchObject({ state: 'delivered', turn: 4, ackAt: '2026-11-03T19:32:00.000Z' });
  });

  it('requeued ack carries the replacement job', () => {
    const fold = foldGuidanceLines([
      guidanceLine('g1'),
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', state: 'requeued', to: 'RQ-PHX-TEST-2' }),
    ]);
    expect(fold.entries[0]).toMatchObject({ state: 'requeued', requeueTo: 'RQ-PHX-TEST-2' });
  });

  it('terminal states refuse later acks and count them', () => {
    const fold = foldGuidanceLines([
      guidanceLine('g1'),
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', state: 'delivered', turn: 2 }),
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', state: 'requeued', to: 'RQ-PHX-TEST-2' }),
    ]);
    expect(fold.entries[0].state).toBe('delivered');
    expect(fold.invalidAcks).toBe(1);
  });

  it('a delivered ack without a turn is refused', () => {
    const fold = foldGuidanceLines([
      guidanceLine('g1'),
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', state: 'delivered' }),
    ]);
    expect(fold.entries[0].state).toBe('queued');
    expect(fold.invalidAcks).toBe(1);
  });

  it('acks for unknown ids are orphans, and junk lines are counted not thrown', () => {
    const fold = foldGuidanceLines([
      'not json',
      '{"v":1,"type":"mystery"}',
      JSON.stringify({ v: 1, type: 'ack', id: 'ghost', state: 'delivered', turn: 1 }),
      guidanceLine('g1'),
    ]);
    expect(fold.entries).toHaveLength(1);
    expect(fold.orphanAcks).toBe(1);
    expect(fold.badLines).toBe(2);
  });

  it('ack before its message in file order is an orphan (first valid ack wins)', () => {
    const fold = foldGuidanceLines([
      JSON.stringify({ v: 1, type: 'ack', id: 'g1', state: 'delivered', turn: 1 }),
      guidanceLine('g1'),
    ]);
    expect(fold.entries[0].state).toBe('queued');
    expect(fold.orphanAcks).toBe(1);
  });
});
