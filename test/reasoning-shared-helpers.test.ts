import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asString,
  classifyTool,
  isReasoningRecord,
  type TurnFeaturesV1,
} from '../src/core/reasoning/extractors.js';
import { ingestCodexRollouts } from '../src/core/reasoning/ingest-codex.js';
import {
  isFeatureRow,
  isPrintableAsciiId,
  isStepRow,
  normalizeStep,
  readBoundedJsonRecord,
  readCursorMap,
  readStoreState,
  resolveHomeSubdir,
  scanFeatures,
  writeCursorMap,
  writeStoreState,
  yieldToLoop,
} from '../src/core/reasoning/store.js';

let home: string;
const saved = {
  HOME: process.env['HOME'],
  ASHLR_HOME: process.env['ASHLR_HOME'],
  CODEX_HOME: process.env['CODEX_HOME'],
  TEST_SUBDIR_ENV: process.env['TEST_SUBDIR_ENV'],
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'reasoning-shared-helpers-'));
  process.env['HOME'] = home;
  delete process.env['ASHLR_HOME'];
  delete process.env['CODEX_HOME'];
  delete process.env['TEST_SUBDIR_ENV'];
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('reasoning shared value guards', () => {
  it('isReasoningRecord accepts plain objects and rejects primitives, null, and arrays', () => {
    expect(isReasoningRecord({})).toBe(true);
    expect(isReasoningRecord({ a: 1 })).toBe(true);
    expect(isReasoningRecord(null)).toBe(false);
    expect(isReasoningRecord(undefined)).toBe(false);
    expect(isReasoningRecord([])).toBe(false);
    expect(isReasoningRecord(['a'])).toBe(false);
    expect(isReasoningRecord('text')).toBe(false);
    expect(isReasoningRecord(42)).toBe(false);
  });

  it('asString returns strings intact and coerces non-strings to empty string', () => {
    expect(asString('hello')).toBe('hello');
    expect(asString('')).toBe('');
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
    expect(asString(123)).toBe('');
    expect(asString({})).toBe('');
  });

  it('store row guards reject arrays as well as primitives', () => {
    expect(isStepRow([])).toBe(false);
    expect(isFeatureRow([])).toBe(false);
    expect(normalizeStep([] as never)).toBeNull();
  });

  it('classifyTool extracts edit targets from both array and map change payloads', () => {
    expect(classifyTool('file_change', { changes: [{ path: '/a/b/one.ts' }, { path: '/a/b/two.ts' }] })).toEqual({
      category: 'edit',
      signature: 'edit one.ts',
      target: 'one.ts',
    });
    expect(classifyTool('file_change', { changes: { '/x/y/map.ts': { type: 'update' } } })).toEqual({
      category: 'edit',
      signature: 'edit map.ts',
      target: 'map.ts',
    });
  });
});

describe('reasoning shared store helpers', () => {
  it('resolveHomeSubdir honors absolute env paths and ignores empty or relative values', () => {
    expect(resolveHomeSubdir('TEST_SUBDIR_ENV', '.dot', 'sub')).toBe(join(home, '.dot', 'sub'));
    process.env['TEST_SUBDIR_ENV'] = '   ';
    expect(resolveHomeSubdir('TEST_SUBDIR_ENV', '.dot', 'sub')).toBe(join(home, '.dot', 'sub'));
    process.env['TEST_SUBDIR_ENV'] = 'relative/dir';
    expect(resolveHomeSubdir('TEST_SUBDIR_ENV', '.dot', 'sub')).toBe(join(home, '.dot', 'sub'));
    const custom = join(home, 'custom-root');
    process.env['TEST_SUBDIR_ENV'] = custom;
    expect(resolveHomeSubdir('TEST_SUBDIR_ENV', '.dot', 'sub')).toBe(join(custom, 'sub'));
  });

  it('isPrintableAsciiId enforces length bounds and printable non-whitespace ASCII', () => {
    expect(isPrintableAsciiId('abc-123_.:/')).toBe(true);
    expect(isPrintableAsciiId('x'.repeat(256))).toBe(true);
    expect(isPrintableAsciiId('x'.repeat(257))).toBe(false);
    expect(isPrintableAsciiId('x'.repeat(120), 120)).toBe(true);
    expect(isPrintableAsciiId('x'.repeat(121), 120)).toBe(false);
    expect(isPrintableAsciiId('')).toBe(false);
    expect(isPrintableAsciiId('has space')).toBe(false);
    expect(isPrintableAsciiId('tab\there')).toBe(false);
    expect(isPrintableAsciiId('ctrl\u0007char')).toBe(false);
    expect(isPrintableAsciiId('café')).toBe(false);
  });

  it('readCursorMap and writeCursorMap round-trip version-1 cursors and prune absent keys', () => {
    const root = join(home, 'store');
    expect(readCursorMap<{ n: number }>('test-cursor', 'files', root)).toEqual({});

    const entries: Record<string, { n: number }> = { keep: { n: 1 }, drop: { n: 2 } };
    expect(writeCursorMap('test-cursor', 'files', entries, new Set(['keep']), root)).toBe(true);
    // Caller map is not mutated when pruning on write.
    expect(Object.keys(entries).sort()).toEqual(['drop', 'keep']);
    expect(readStoreState('test-cursor', root)).toEqual({ v: 1, files: { keep: { n: 1 } } });
    expect(readCursorMap<{ n: number }>('test-cursor', 'files', root)).toEqual({ keep: { n: 1 } });

    // Malformed / wrong-version / array-valued cursors fall back cleanly to {}.
    expect(writeStoreState('test-cursor', { v: 2, files: { keep: { n: 1 } } }, root)).toBe(true);
    expect(readCursorMap('test-cursor', 'files', root)).toEqual({});
    expect(writeStoreState('test-cursor', { v: 1, files: ['not-a-map'] }, root)).toBe(true);
    expect(readCursorMap('test-cursor', 'files', root)).toEqual({});
  });

  it('readBoundedJsonRecord reads plain JSON objects and rejects symlinks, arrays, primitives, and oversized files', async () => {
    const dir = join(home, 'json');
    mkdirSync(dir, { recursive: true });

    const valid = join(dir, 'ok.json');
    writeFileSync(valid, JSON.stringify({ engine: 'codex', id: 's1' }));
    expect(await readBoundedJsonRecord(valid)).toEqual({ engine: 'codex', id: 's1' });

    const arr = join(dir, 'array.json');
    writeFileSync(arr, '[1,2,3]');
    expect(await readBoundedJsonRecord(arr)).toBeNull();

    const prim = join(dir, 'null.json');
    writeFileSync(prim, 'null');
    expect(await readBoundedJsonRecord(prim)).toBeNull();

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{broken');
    expect(await readBoundedJsonRecord(bad)).toBeNull();

    const big = join(dir, 'big.json');
    writeFileSync(big, JSON.stringify({ data: 'a'.repeat(200) }));
    expect(await readBoundedJsonRecord(big, 64)).toBeNull();

    const link = join(dir, 'link.json');
    symlinkSync(valid, link);
    expect(await readBoundedJsonRecord(link)).toBeNull();

    expect(await readBoundedJsonRecord(join(dir, 'missing.json'))).toBeNull();
  });

  it('yieldToLoop resolves asynchronously', async () => {
    let resolved = false;
    const p = yieldToLoop().then(() => { resolved = true; });
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });
});

describe('codex rollout stream_error vs error handling', () => {
  it('treats stream_error as non-fatal while error marks an incomplete turn as errored', async () => {
    const base = Date.now() - 3_600_000;
    const ts = (s: number): string => new Date(base + s * 1_000).toISOString();
    const row = (s: number, type: string, payload: Record<string, unknown>): string =>
      JSON.stringify({ timestamp: ts(s), type, payload });
    const d = new Date(base);
    const sessionsRoot = join(home, '.codex', 'sessions');
    const dir = join(sessionsRoot, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rollout-stream-err.jsonl'),
      [
        row(0, 'session_meta', { id: 'thread-se', cwd: join(home, 'repo'), originator: 'codex_exec', source: 'exec' }),
        row(1, 'event_msg', { type: 'task_started', turn_id: 't-ok' }),
        row(2, 'event_msg', { type: 'stream_error', message: 'transient reconnect' }),
        row(3, 'event_msg', { type: 'agent_message', message: 'recovered' }),
        row(4, 'event_msg', { type: 'task_complete', turn_id: 't-ok' }),
        row(5, 'event_msg', { type: 'task_started', turn_id: 't-err' }),
        row(6, 'event_msg', { type: 'error', message: 'rate limit exceeded' }),
        row(7, 'event_msg', { type: 'agent_message', message: 'stopped' }),
        // Opening another turn closes the previous turn with outcome=null so turn.errored decides it.
        row(8, 'event_msg', { type: 'task_started', turn_id: 't-next' }),
      ].join('\n') + '\n',
    );

    const res = await ingestCodexRollouts({ sessionsRoot, verseRoot: join(home, '.ashlr', 'verse') });
    expect(res.features).toBe(2);
    const out: TurnFeaturesV1[] = [];
    await scanFeatures({ fromMs: base - 86_400_000, toMs: Date.now() + 86_400_000 }, (f) => { out.push(f); });
    const okTurn = out.find((f) => f.turnId === 't-ok');
    const errTurn = out.find((f) => f.turnId === 't-err');
    expect(okTurn).toMatchObject({ outcome: 'ok', errorClass: null, struggle: false });
    expect(errTurn).toMatchObject({ outcome: 'error', errorClass: 'rate-limit', struggle: true });
  });
});
