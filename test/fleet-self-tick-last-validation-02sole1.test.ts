/**
 * RQ-PHX-LASTRUNVALIDATE02SOLE1 — readSelfTickLast validates the persisted
 * record field by field before it answers ok. Round trips go through the real
 * writer (runSelfTick and writeSelfTickLast); malformed fixtures are raw files
 * mutated from a writer-produced record. A malformed record must read
 * unreadable, never an ok verdict that drops a failed step.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readSelfTickLast, SELF_TICK_LAST, writeSelfTickLast,
} from '../src/core/fleet/self-tick-last.js';
import { runSelfTick, type SelfTickReport, type SelfTickSteps } from '../src/core/fleet/self-tick.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z');
const AT = new Date(NOW_MS).toISOString();
const LAST = () => join(runsDir, SELF_TICK_LAST);

let runsDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'self-tick-last-validation-'));
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
});
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

/** Steps whose exit codes come from `codes`; a missing name exits 0. */
const steps = (codes: Partial<Record<string, number>> = {}): SelfTickSteps => {
  const run = (name: string) => async () => ({
    exitCode: codes[name] ?? 0,
    output: JSON.stringify({ ok: name }),
  });
  return {
    'reset-release': run('reset-release'),
    'lane-autohold': run('lane-autohold'),
    'planner-tick': run('planner-tick'),
  };
};

/** Run one pass through the real runner, which persists it via the writer. */
const runAndPersist = async (
  options: { apply?: boolean; codes?: Partial<Record<string, number>> } = {},
) => runSelfTick({
  runsDir, apply: options.apply, steps: steps(options.codes), now: () => NOW_MS,
});

/** The record the writer stored, as a plain object a fixture can mutate. */
const storedRecord = (): Record<string, unknown> =>
  JSON.parse(readFileSync(LAST(), 'utf8')) as Record<string, unknown>;

/** Replace the stored record with `record` as raw JSON. */
const writeRaw = (record: unknown): void => {
  writeFileSync(LAST(), JSON.stringify(record), 'utf8');
};

/** Mutate a fresh writer-produced record, then store the result raw. */
const mutateStored = (mutate: (record: Record<string, unknown>) => void): void => {
  const record = storedRecord();
  mutate(record);
  writeRaw(record);
};

type StoredStep = Record<string, unknown>;
const storedSteps = (record: Record<string, unknown>): StoredStep[] =>
  record['steps'] as StoredStep[];

describe('self-tick last record: writer round trips', () => {
  it('a failing step survives the writer and lands in the verdict', async () => {
    await runAndPersist({ codes: { 'lane-autohold': 2 } });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({
      state: 'ok', at: AT, mode: 'dry-run', ranState: 'ran',
      ageSeconds: 0, failedSteps: ['lane-autohold'],
    });
  });

  it('every failing step is named, in fixed order, in apply mode', async () => {
    await runAndPersist({ apply: true, codes: { 'reset-release': 1, 'planner-tick': 3 } });
    expect(readSelfTickLast(runsDir, NOW_MS)).toMatchObject({
      state: 'ok', mode: 'apply', ranState: 'ran',
      failedSteps: ['reset-release', 'planner-tick'],
    });
  });

  it('a clean pass reads ok with no failed steps', async () => {
    await runAndPersist();
    expect(readSelfTickLast(runsDir, NOW_MS)).toMatchObject({ state: 'ok', failedSteps: [] });
  });

  it('a step that throws is stored failed with exit 1 and a null report', async () => {
    const throwing: SelfTickSteps = {
      ...steps(),
      'lane-autohold': async () => { throw new Error('seam exploded'); },
    };
    const { report } = await runSelfTick({ runsDir, steps: throwing, now: () => NOW_MS });
    expect(report.steps[1]).toEqual({ step: 'lane-autohold', state: 'failed', exitCode: 1, report: null });
    expect(readSelfTickLast(runsDir, NOW_MS)).toMatchObject({ state: 'ok', failedSteps: ['lane-autohold'] });
  });

  it('a busy report (no steps) reads ok with ranState busy through the writer', () => {
    const busy: SelfTickReport = { v: 1, at: AT, mode: 'dry-run', state: 'busy', steps: [] };
    writeSelfTickLast(runsDir, busy);
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({
      state: 'ok', at: AT, mode: 'dry-run', ranState: 'busy', ageSeconds: 0, failedSteps: [],
    });
  });

  it('a single-step ran record written directly reads ok', () => {
    writeSelfTickLast(runsDir, {
      v: 1, at: AT, mode: 'dry-run', state: 'ran',
      steps: [{ step: 'planner-tick', state: 'failed', exitCode: 4, report: { error: 'x' } }],
    });
    expect(readSelfTickLast(runsDir, NOW_MS)).toMatchObject({ state: 'ok', failedSteps: ['planner-tick'] });
  });

  it('a report carrying a JSON null, an object or a truncation marker is accepted', () => {
    writeSelfTickLast(runsDir, {
      v: 1, at: AT, mode: 'apply', state: 'ran',
      steps: [
        { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
        { step: 'lane-autohold', state: 'ok', exitCode: 0, report: { truncated: true } },
        { step: 'planner-tick', state: 'failed', exitCode: 1, report: { released: [] } },
      ],
    });
    expect(readSelfTickLast(runsDir, NOW_MS)).toMatchObject({ state: 'ok', failedSteps: ['planner-tick'] });
  });
});

describe('self-tick last record: contradictions and tampering', () => {
  it('a failed step flipped to ok cannot make the verdict clean', async () => {
    await runAndPersist({ codes: { 'lane-autohold': 1 } });
    mutateStored((record) => { storedSteps(record)[1]!['state'] = 'ok'; });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a failed step whose exit code becomes 0 is unreadable', async () => {
    await runAndPersist({ codes: { 'planner-tick': 1 } });
    mutateStored((record) => { storedSteps(record)[2]!['exitCode'] = 0; });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('an ok step with a nonzero exit code is unreadable', async () => {
    await runAndPersist();
    mutateStored((record) => { storedSteps(record)[0]!['exitCode'] = 1; });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a failed step cannot vanish when a neighbour is malformed', async () => {
    await runAndPersist({ codes: { 'lane-autohold': 1 } });
    mutateStored((record) => { storedSteps(record)[0] = null as unknown as StoredStep; });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a step renamed to an unknown name is unreadable, not a dropped failure', async () => {
    await runAndPersist({ codes: { 'lane-autohold': 1 } });
    mutateStored((record) => { storedSteps(record)[1]!['step'] = 'lane-autohold-v2'; });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a busy record that carries steps is unreadable', () => {
    writeRaw({
      v: 1, at: AT, mode: 'dry-run', state: 'busy',
      steps: [{ step: 'reset-release', state: 'ok', exitCode: 0, report: null }],
    });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a ran record with no steps is unreadable: no evidence for an ok verdict', () => {
    writeRaw({ v: 1, at: AT, mode: 'apply', state: 'ran', steps: [] });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a duplicated step name is unreadable', async () => {
    await runAndPersist();
    mutateStored((record) => {
      const [first] = storedSteps(record);
      record['steps'] = [first, first];
    });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('steps out of the fixed execution order are unreadable', async () => {
    await runAndPersist();
    mutateStored((record) => { record['steps'] = [...storedSteps(record)].reverse(); });
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });
});

describe('self-tick last record: malformed raw fixtures', () => {
  const malformed: [string, (record: Record<string, unknown>) => void][] = [
    ['a missing version', (r) => { delete r['v']; }],
    ['a version other than 1', (r) => { r['v'] = 2; }],
    ['a string version', (r) => { r['v'] = '1'; }],
    ['an unknown step state', (r) => { storedSteps(r)[0]!['state'] = 'skipped'; }],
    ['a missing step state', (r) => { delete storedSteps(r)[0]!['state']; }],
    ['a negative exit code', (r) => { storedSteps(r)[0]!['exitCode'] = -1; }],
    ['an exit code above 255', (r) => { storedSteps(r)[2]!['exitCode'] = 256; }],
    ['a fractional exit code', (r) => { storedSteps(r)[2]!['exitCode'] = 1.5; }],
    ['a string exit code', (r) => { storedSteps(r)[0]!['exitCode'] = '0'; }],
    ['a null exit code (what NaN stringifies to)', (r) => { storedSteps(r)[0]!['exitCode'] = null; }],
    ['a missing exit code', (r) => { delete storedSteps(r)[0]!['exitCode']; }],
    ['a step entry that is null', (r) => { storedSteps(r)[1] = null as unknown as StoredStep; }],
    ['a step entry that is an array', (r) => { storedSteps(r)[1] = [] as unknown as StoredStep; }],
    ['a step entry that is a string', (r) => { storedSteps(r)[1] = 'lane-autohold' as unknown as StoredStep; }],
    ['a step with no report key', (r) => { delete storedSteps(r)[0]!['report']; }],
    ['a step name that is not a string', (r) => { storedSteps(r)[0]!['step'] = 7; }],
    ['steps that is null', (r) => { r['steps'] = null; }],
    ['steps that is an object', (r) => { r['steps'] = { 0: storedSteps(r)[0] }; }],
    ['a mode outside apply and dry-run', (r) => { r['mode'] = 'sideways'; }],
    ['a state outside ran and busy', (r) => { r['state'] = 'done'; }],
    ['an unparseable timestamp', (r) => { r['at'] = 'yesterday'; }],
  ];

  it.each(malformed)('%s reads unreadable, never ok', async (_label, mutate) => {
    await runAndPersist({ codes: { 'lane-autohold': 1 } });
    mutateStored(mutate);
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a top-level null, array or scalar reads unreadable', () => {
    for (const raw of [null, [], 'ok', 3]) {
      writeRaw(raw);
      expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
    }
  });

  it('an empty file reads unreadable', () => {
    writeFileSync(LAST(), '', 'utf8');
    expect(readSelfTickLast(runsDir, NOW_MS)).toEqual({ state: 'unreadable' });
  });

  it('a missing file still reads null', () => {
    expect(readSelfTickLast(runsDir, NOW_MS)).toBeNull();
  });
});
