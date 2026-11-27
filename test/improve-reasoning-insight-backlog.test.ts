import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REASONING_INSIGHT_BACKLOG_MAX_ITEMS,
  REASONING_INSIGHT_MIN_COUNT,
  REASONING_INSIGHT_MIN_DAYS,
  REASONING_INSIGHT_WINDOW_DAYS,
  featureClusterKeys,
  reasoningInsightBacklogItems,
  reasoningInsightId,
} from '../src/core/improve/reasoning-insight-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { extractTurnFeatures, type TraceAction, type TurnFeaturesV1 } from '../src/core/reasoning/extractors.js';
import { DigestBuilder } from '../src/core/reasoning/insights.js';
import { appendFeatures } from '../src/core/reasoning/store.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-24T15:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let n = 0;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reasoning-insight-backlog-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const tool = (name: string, input: unknown, ok: boolean | null): TraceAction =>
  ({ kind: 'tool', ref: `session:x#${++n}`, at: '', name, input, ok });
const bash = (command: string, ok: boolean | null): TraceAction => tool('Bash', { command }, ok);
const read = (file: string): TraceAction => tool('Read', { file_path: file }, true);
const edit = (file: string): TraceAction => tool('Edit', { file_path: file }, true);
const think = (text: string): TraceAction => ({ kind: 'thinking', ref: `verse:x:${++n}`, at: '', text });
const say = (text: string): TraceAction => ({ kind: 'message', ref: `session:x#${++n}`, at: '', text });

/** One finished turn at `atMs`, ended one minute later unless overridden. */
function feature(actions: TraceAction[], opts: {
  atMs?: number; endedAtMs?: number | null; repo?: string | null; engine?: string;
  outcome?: TurnFeaturesV1['outcome']; errorClass?: string | null;
} = {}): TurnFeaturesV1 {
  n += 1;
  const atMs = opts.atMs ?? NOW - DAY;
  const endedAtMs = opts.endedAtMs === undefined ? atMs + 60_000 : opts.endedAtMs;
  return extractTurnFeatures({
    id: `fleet:run${n}:t${n}`,
    source: 'fleet',
    sessionId: null,
    runId: `run${n}`,
    repo: opts.repo === undefined ? '~/src/app' : opts.repo,
    engine: opts.engine ?? 'claude',
    model: null,
    turnId: `t${n}`,
    startedAt: iso(atMs),
    endedAt: endedAtMs === null ? null : iso(endedAtMs),
    outcome: opts.outcome === undefined ? 'ok' : opts.outcome,
    errorClass: opts.errorClass ?? null,
    actions: actions.map((a) => ({ ...a, at: iso(atMs + 1_000) })),
  });
}

const items = (over: Partial<Parameters<typeof reasoningInsightBacklogItems>[0]> = {}) =>
  reasoningInsightBacklogItems({ repo: 'ashlrai/phantom', root, now: new Date(NOW), ...over });

describe('featureClusterKeys', () => {
  it('mirrors the digest builder cluster calls for every signal', () => {
    const f = feature([
      bash('npm test', false), bash('npm test', false),
      read('x.ts'), read('x.ts'), read('x.ts'),
      think("I'm not sure. This is unclear."),
      think('Actually, wait. Let me revert the change. Actually, wait.'),
      edit('a.ts'), edit('a.ts'), edit('a.ts'),
    ]);
    const keys = featureClusterKeys(f).map((k) => `${k.kind}/${k.variant}${k.signature ? `:${k.signature}` : ''}`);
    expect(keys).toContain('struggle/failure:npm test');
    expect(keys.some((k) => k.startsWith('loop/loop'))).toBe(true);
    expect(keys.some((k) => k.startsWith('uncertainty/'))).toBe(true);
    expect(keys.some((k) => k.startsWith('backtrack/'))).toBe(true);
    expect(keys).toContain('verification-gap/untested');
  });

  it('keys error outcomes, give-ups, claims and wins', () => {
    const err = feature([], { outcome: 'error', errorClass: 'rate-limit' });
    expect(featureClusterKeys(err)).toContainEqual({ kind: 'struggle', variant: 'error', signature: 'rate-limit' });
    const gaveUp = feature([think("I can't figure this out, I give up.")]);
    expect(featureClusterKeys(gaveUp)).toContainEqual({ kind: 'struggle', variant: 'gave-up', signature: null });
    const claim = feature([edit('a.ts'), say('All tests pass.')]);
    expect(featureClusterKeys(claim)).toContainEqual({ kind: 'verification-gap', variant: 'claim', signature: null });
    const win = feature([edit('a.ts'), bash('npm test', true)]);
    expect(featureClusterKeys(win)).toContainEqual({ kind: 'win', variant: 'win', signature: null });
  });
});

describe('reasoningInsightId', () => {
  it('reproduces the digest insight id for the same cluster', () => {
    const f = feature([bash('npm test', false), bash('npm test', false)], { repo: '~/src/app', engine: 'claude' });
    const builder = new DigestBuilder({ fromMs: NOW - 7 * DAY, toMs: NOW });
    builder.addFeature(f);
    const insight = builder.build(NOW).insights.find((i) => i.kind === 'struggle');
    expect(insight).toBeDefined();
    const key = featureClusterKeys(f).find((k) => k.variant === 'failure');
    expect(reasoningInsightId(key!, f.repo, f.engine)).toBe(insight!.id);
  });
});

describe('reasoningInsightBacklogItems', () => {
  const T_OLD = NOW - 3 * DAY; // 2026-11-21
  const T_MID = NOW - 2 * DAY; // 2026-11-22
  const T_NEW = NOW - DAY; // 2026-11-23

  it('emits one item per recurring adverse insight across days', async () => {
    appendFeatures([
      feature([bash('npm test', false)], { atMs: T_OLD }),
      feature([bash('npm test', false)], { atMs: T_MID }),
      feature([bash('npm test', false)], { atMs: T_NEW }),
    ], root);
    const out = await items();
    expect(out).toHaveLength(1);
    const item = out[0]!;
    expect(item.id).toMatch(/^fleet-reasoning-ri-[0-9a-f]{16}$/);
    expect(item.repo).toBe('ashlrai/phantom');
    expect(item.area).toBe('reasoning-insights');
    expect(item.priority).toBe(3);
    expect(item.title).toContain('npm test');
    expect(item.prompt).toContain('3 recorded occurrence(s)');
    expect(item.prompt).toContain('3 distinct turn(s)');
    expect(item.prompt).toContain('3 distinct UTC day(s)');
    expect(item.prompt).toContain('2026-11-21, 2026-11-22, 2026-11-23');
    expect(item.prompt).toContain("repo '~/src/app'");
    expect(item.prompt).toContain("engine 'claude'");
    expect(validBacklogItem(item)).not.toBeNull();
  });

  it('suppresses clusters recorded on a single UTC day', async () => {
    appendFeatures([
      feature([bash('npm test', false), bash('npm test', false)], { atMs: T_NEW }),
      feature([bash('npm test', false)], { atMs: T_NEW + 2 * HOUR }),
      feature([bash('npm test', false)], { atMs: T_NEW + 4 * HOUR }),
    ], root);
    expect(await items()).toEqual([]);
  });

  it('suppresses clusters below the occurrence bar', async () => {
    appendFeatures([
      feature([bash('npm test', false)], { atMs: T_OLD }),
      feature([bash('npm test', false)], { atMs: T_NEW }),
    ], root);
    // Two occurrences across two days form an info-severity insight but stay under MIN_COUNT.
    expect(await items()).toEqual([]);
  });

  it('suppresses a single long turn spanning midnight — one turn is one day', async () => {
    // Turn starts 2026-11-22 23:30Z, ends 2026-11-23 00:30Z: firstAt/lastAt
    // span two UTC days but the endedAt day is the only recorded day.
    const start = Date.parse('2026-11-22T23:30:00.000Z');
    appendFeatures([
      feature([bash('npm test', false), bash('npm test', false), bash('npm test', false)], {
        atMs: start, endedAtMs: start + HOUR,
      }),
    ], root);
    expect(await items()).toEqual([]);
  });

  it('never emits verification-gap or win insights', async () => {
    appendFeatures([
      // claimUnverified + verificationGap across two days (edits, no passing check, success claim)
      feature([edit('a.ts'), say('All tests pass.')], { atMs: T_OLD }),
      feature([edit('b.ts'), say('All tests pass.')], { atMs: T_MID }),
      feature([edit('c.ts'), say('All tests pass.')], { atMs: T_NEW }),
      // wins across two days
      feature([edit('d.ts'), bash('npm test', true)], { atMs: T_OLD }),
      feature([edit('e.ts'), bash('npm test', true)], { atMs: T_NEW }),
    ], root);
    expect(await items()).toEqual([]);
  });

  it('emits loop, gave-up and error insights at the same bar', async () => {
    appendFeatures([
      // loop: three identical Reads, no edit between — two turns, two days
      feature([read('x.ts'), read('x.ts'), read('x.ts')], { atMs: T_OLD }),
      feature([read('x.ts'), read('x.ts'), read('x.ts')], { atMs: T_NEW }),
      // gave-up: give-up reasoning, no edits — three turns, two days
      feature([think("I can't figure this out, I give up.")], { atMs: T_OLD }),
      feature([think('I give up on this one.')], { atMs: T_MID }),
      feature([think('Giving up — unable to fix it.')], { atMs: T_NEW }),
      // error: three error outcomes, two days
      feature([], { atMs: T_OLD, outcome: 'error', errorClass: 'rate-limit' }),
      feature([], { atMs: T_MID, outcome: 'error', errorClass: 'rate-limit' }),
      feature([], { atMs: T_NEW, outcome: 'error', errorClass: 'rate-limit' }),
    ], root);
    const out = await items();
    const prompts = out.map((i) => i.prompt).join('\n');
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(prompts).toContain('repeating the same tool call');
    expect(prompts).toContain('giving up without making a change');
    expect(prompts).toContain('ending in the same error');
    expect(out.every((i) => i.id.startsWith('fleet-reasoning-ri-'))).toBe(true);
  });

  it('keeps uncertainty and backtrack insights honest at the bar', async () => {
    appendFeatures([
      feature([think("I'm not sure. This is unclear.")], { atMs: T_OLD }),
      feature([think("I'm not sure. This is unclear.")], { atMs: T_MID }),
      feature([think("I'm not sure. This is unclear.")], { atMs: T_NEW }),
      feature([think('Actually, wait. Let me revert the change.')], { atMs: T_OLD }),
      feature([think('Actually, wait. Let me revert the change.')], { atMs: T_MID }),
      feature([think('Actually, wait. Let me revert the change.')], { atMs: T_NEW }),
    ], root);
    const out = await items();
    const prompts = out.map((i) => i.prompt).join('\n');
    expect(prompts).toContain('reasoning through uncertainty');
    expect(prompts).toContain('backtracking or re-editing');
  });

  it('emits only for the fleet repository and dedupes stably', async () => {
    appendFeatures([
      feature([bash('npm test', false)], { atMs: T_OLD }),
      feature([bash('npm test', false)], { atMs: T_MID }),
      feature([bash('npm test', false)], { atMs: T_NEW }),
    ], root);
    expect(await items({ repo: 'ashlrai/other' })).toEqual([]);
    expect(await items({ repo: 'AshlrAI/Phantom' })).toHaveLength(1);
    expect(await items({ repo: '' })).toEqual([]);
    const first = await items();
    const second = await items();
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(await items({ limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for a missing or empty store', async () => {
    expect(await items()).toEqual([]);
    expect(await reasoningInsightBacklogItems({ repo: 'ashlrai/phantom', root: join(root, 'nope'), now: new Date(NOW) })).toEqual([]);
  });

  it('honours the window and count constants', () => {
    expect(REASONING_INSIGHT_WINDOW_DAYS).toBe(7);
    expect(REASONING_INSIGHT_MIN_COUNT).toBe(3);
    expect(REASONING_INSIGHT_MIN_DAYS).toBe(2);
    expect(REASONING_INSIGHT_BACKLOG_MAX_ITEMS).toBe(8);
  });

  it('appends reasoning-insight items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      // discoverBacklog anchors its window at the real clock, so features are
      // stamped relative to Date.now() — UTC noons two and one days back
      // guarantee distinct UTC days at any wall-clock time the suite runs.
      const d = new Date();
      const day2 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, 12);
      const day1 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 12);
      // reasoningRoot() resolves under the relocated test HOME.
      appendFeatures([
        feature([bash('npm test', false)], { atMs: day2 }),
        feature([bash('npm test', false), bash('npm test', false)], { atMs: day1 }),
        feature([bash('npm test', false)], { atMs: day1 + 2 * HOUR }),
      ]);
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const insightItems = first.items.filter((i) => i.id.startsWith('fleet-reasoning-'));
      expect(insightItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(insightItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-reasoning-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-reasoning-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
