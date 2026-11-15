/**
 * idea-verdicts.test.ts — the append-only idea verdict store
 * (RQ-PHX-IDEANOTNOW94).
 *
 * Units under test:
 *   1. recordIdeaVerdict / readIdeaVerdicts — append, latest-per-id wins,
 *      malformed lines skipped, read bounded to the tail, reason clipped.
 *   2. ideaVerdictLive — "never" always live; "not now" for seven days.
 *   3. parseIdeaVerdict — route-body validation.
 *   4. declinedIdeaFeedback — producer prompt text.
 *
 * Every test writes under a fresh tmp dir via the explicit `path` dep — no
 * HOME relocation needed.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declinedIdeaFeedback,
  ideaVerdictLive,
  NOT_NOW_HIDE_MS,
  parseIdeaVerdict,
  REASON_MAX,
  READ_TAIL_LINES,
  recordIdeaVerdict,
  readIdeaVerdicts,
  type IdeaVerdictEntry,
} from '../src/core/ideas/idea-verdicts.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const tmp = () => join(mkdtempSync(join(tmpdir(), 'ashlr-verdicts-')), 'verdicts.jsonl');
const entry = (ideaId: string, verdict: 'not-now' | 'never', at: string, reason = ''): IdeaVerdictEntry => ({ ideaId, verdict, reason, at });

describe('recordIdeaVerdict + readIdeaVerdicts', () => {
  it('appends one JSONL line per verdict and reads the latest per id', () => {
    const path = tmp();
    const first = recordIdeaVerdict({ ideaId: 'a', verdict: 'not-now', reason: 'busy' }, { now: 1000, path });
    const second = recordIdeaVerdict({ ideaId: 'a', verdict: 'never', reason: 'changed mind' }, { now: 2000, path });
    recordIdeaVerdict({ ideaId: 'b', verdict: 'not-now', reason: '' }, { now: 3000, path });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const verdicts = readIdeaVerdicts({ path });
    expect(verdicts.get('a')).toEqual(entry('a', 'never', new Date(2000).toISOString(), 'changed mind'));
    expect(verdicts.get('b')).toEqual(entry('b', 'not-now', new Date(3000).toISOString()));
  });

  it('creates the parent directory and writes the file 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-verdicts-'));
    const path = join(dir, 'nested', 'deep', 'verdicts.jsonl');
    expect(recordIdeaVerdict({ ideaId: 'x', verdict: 'not-now', reason: '' }, { now: 5, path })).not.toBeNull();
    const stat = statSync(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('skips malformed lines instead of failing the read', () => {
    const path = tmp();
    writeFileSync(path, [
      'not json at all',
      '{"ideaId":"a","verdict":"bogus","reason":"","at":"2026-11-01T00:00:00.000Z"}',
      '{"ideaId":"","verdict":"never","reason":"","at":"2026-11-01T00:00:00.000Z"}',
      '{"ideaId":"a","verdict":"never","reason":"","at":"not a date"}',
      JSON.stringify(entry('good', 'never', '2026-11-02T00:00:00.000Z', 'no')),
    ].join('\n') + '\n');
    const verdicts = readIdeaVerdicts({ path });
    expect(verdicts.size).toBe(1);
    expect(verdicts.get('good')?.verdict).toBe('never');
  });

  it('bounds the read to the last READ_TAIL_LINES lines', () => {
    const path = tmp();
    const lines = Array.from({ length: READ_TAIL_LINES + 50 }, (_, i) =>
      JSON.stringify(entry(`id-${i}`, 'never', '2026-11-01T00:00:00.000Z'))).join('\n') + '\n';
    writeFileSync(path, lines);
    const verdicts = readIdeaVerdicts({ path });
    expect(verdicts.has('id-0')).toBe(false);
    expect(verdicts.has(`id-${READ_TAIL_LINES + 49}`)).toBe(true);
    expect(verdicts.size).toBe(READ_TAIL_LINES);
  });

  it('clips and flattens the reason when recording', () => {
    const path = tmp();
    const long = `x\n${'y'.repeat(REASON_MAX + 50)}`;
    recordIdeaVerdict({ ideaId: 'r', verdict: 'not-now', reason: long }, { now: 1, path });
    const read = readIdeaVerdicts({ path }).get('r')!;
    expect(read.reason.length).toBeLessThanOrEqual(REASON_MAX);
    expect(read.reason).not.toContain('\n');
  });

  it('returns null instead of throwing when the file cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-verdicts-'));
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const path = join(blocker, 'verdicts.jsonl'); // dirname is a file
    expect(recordIdeaVerdict({ ideaId: 'z', verdict: 'never', reason: '' }, { path })).toBeNull();
  });

  it('reads an absent or empty file as no verdicts', () => {
    expect(readIdeaVerdicts({ path: join(mkdtempSync(join(tmpdir(), 'ashlr-verdicts-')), 'none.jsonl') }).size).toBe(0);
    const path = tmp();
    writeFileSync(path, '');
    expect(readIdeaVerdicts({ path }).size).toBe(0);
  });
});

describe('ideaVerdictLive', () => {
  const at = '2026-11-03T12:00:00.000Z';
  const atMs = Date.parse(at);
  it('keeps a "never" verdict live forever', () => {
    expect(ideaVerdictLive(entry('i', 'never', at), atMs + 365 * DAY_MS)).toBe(true);
  });
  it('keeps a "not now" verdict live for seven days, then lets it lapse', () => {
    const e = entry('i', 'not-now', at);
    expect(ideaVerdictLive(e, atMs)).toBe(true);
    expect(ideaVerdictLive(e, atMs + NOT_NOW_HIDE_MS - 1)).toBe(true);
    expect(ideaVerdictLive(e, atMs + NOT_NOW_HIDE_MS)).toBe(false);
    expect(ideaVerdictLive(e, atMs + 30 * DAY_MS)).toBe(false);
  });
  it('treats an unreadable timestamp as live rather than resurfacing', () => {
    expect(ideaVerdictLive(entry('i', 'not-now', 'garbage'), atMs)).toBe(true);
  });
});

describe('parseIdeaVerdict', () => {
  it('rejects non-object bodies and missing fields', () => {
    for (const body of [null, undefined, 'x', 42, [], { verdict: 'never' }, { ideaId: 5, verdict: 'never' }, { ideaId: '', verdict: 'never' }]) {
      expect(parseIdeaVerdict(body).ok).toBe(false);
    }
  });
  it('rejects an unknown verdict', () => {
    expect(parseIdeaVerdict({ ideaId: 'a', verdict: 'maybe' }).ok).toBe(false);
    expect(parseIdeaVerdict({ ideaId: 'a', verdict: 'NEVER' }).ok).toBe(false);
  });
  it('rejects a non-string reason but accepts a missing one', () => {
    expect(parseIdeaVerdict({ ideaId: 'a', verdict: 'never', reason: 3 }).ok).toBe(false);
    const ok = parseIdeaVerdict({ ideaId: 'a', verdict: 'never' });
    expect(ok).toEqual({ ok: true, ideaId: 'a', verdict: 'never', reason: '' });
  });
  it('flattens and clips the reason', () => {
    const ok = parseIdeaVerdict({ ideaId: 'a', verdict: 'not-now', reason: `one\ntwo ${'z'.repeat(REASON_MAX)}` });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.reason.length).toBeLessThanOrEqual(REASON_MAX);
      expect(ok.reason.startsWith('one two')).toBe(true);
    }
  });
});

describe('declinedIdeaFeedback', () => {
  it('is empty when there are no live verdicts', () => {
    const path = tmp();
    recordIdeaVerdict({ ideaId: 'old', verdict: 'not-now', reason: 'stale' }, { now: 0, path });
    expect(declinedIdeaFeedback(Date.now(), { path })).toBe('');
    expect(declinedIdeaFeedback(Date.now(), { path: join(mkdtempSync(join(tmpdir(), 'ashlr-verdicts-')), 'none.jsonl') })).toBe('');
  });
  it('lists live verdicts newest-first with their reasons', () => {
    const path = tmp();
    const nowMs = Date.now();
    recordIdeaVerdict({ ideaId: 'a', verdict: 'not-now', reason: 'too risky' }, { now: nowMs - DAY_MS, path });
    recordIdeaVerdict({ ideaId: 'b', verdict: 'never', reason: '' }, { now: nowMs, path });
    const text = declinedIdeaFeedback(nowMs, { path });
    expect(text).toContain('DECLINED IDEAS');
    expect(text).toContain('- never: (no reason given)');
    expect(text).toContain('- not now: too risky');
    expect(text.indexOf('- never:')).toBeLessThan(text.indexOf('- not now:'));
  });
});
