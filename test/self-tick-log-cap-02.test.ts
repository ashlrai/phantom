/**
 * RQ-PHX-SELFTICKLOGCAP02 — capSelfTickLog bounds the scheduled self-tick
 * log (~/.ashlr/logs/self-tick.jsonl) in place: absent, under-limit and
 * symlinked paths are left alone, an oversize regular file keeps only its
 * newest keepBytes starting at a line boundary and lands at mode 0o600,
 * and a writer holding the file open in append mode keeps writing into the
 * capped file (the reason the cap is ftruncate, never tmp+rename).
 */
import {
  closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capSelfTickLog, SELF_TICK_LOG_KEEP_BYTES, SELF_TICK_LOG_MAX_BYTES,
  selfTickLogPath,
} from '../src/core/fleet/self-tick-log-cap.js';

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'self-tick-log-cap-'));
  log = join(dir, 'self-tick.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** count complete lines of `prefix-<i>` plus a final `tail` line. */
const lines = (count: number, tail: string): string =>
  Array.from({ length: count }, (_, i) => `line-${i}`).join('\n') + `\n${tail}\n`;

describe('capSelfTickLog', () => {
  it('selfTickLogPath names the one shared log under a home', () => {
    expect(selfTickLogPath('/h')).toBe(join('/h', '.ashlr', 'logs', 'self-tick.jsonl'));
  });

  it('reports absent for a missing file', () => {
    expect(capSelfTickLog(log)).toEqual({ state: 'absent' });
  });

  it('reports under and leaves an at-or-under-limit file untouched', () => {
    const content = lines(4, 'newest');
    writeFileSync(log, content);
    for (const size of [1, content.length]) {
      writeFileSync(log, content.slice(0, size));
      expect(capSelfTickLog(log, { maxBytes: content.length })).toEqual(
        { state: 'under', bytesBefore: size });
      expect(readFileSync(log, 'utf8').length).toBe(size);
    }
  });

  it('caps an oversize log at a line boundary, keeps the newest line, mode 0o600', () => {
    const line = `{"step":"planner-tick","report":"${'x'.repeat(90)} "}\n`;
    const count = Math.ceil((SELF_TICK_LOG_MAX_BYTES + 4096) / Buffer.byteLength(line));
    const newest = '{"step":"newest"}\n';
    writeFileSync(log, line.repeat(count) + newest, { mode: 0o644 });
    const before = statSync(log).size;
    expect(before).toBeGreaterThan(SELF_TICK_LOG_MAX_BYTES);

    const result = capSelfTickLog(log);
    expect(result).toEqual({ state: 'capped', bytesBefore: before, bytesAfter: expect.any(Number) });
    const after = statSync(log);
    expect(after.size).toBe(result.bytesAfter);
    expect(after.size).toBeLessThanOrEqual(SELF_TICK_LOG_KEEP_BYTES);
    expect(after.size).toBeLessThan(SELF_TICK_LOG_MAX_BYTES);
    const kept = readFileSync(log, 'utf8');
    expect(kept.startsWith('{')).toBe(true); // cut after a newline: no partial first line
    expect(kept.endsWith(newest)).toBe(true);
    expect(kept).not.toContain('line-0'); // the old head is gone
    expect(after.mode & 0o777).toBe(0o600);
  });

  it('skips a symlink and leaves its target untouched', () => {
    const target = join(dir, 'real.jsonl');
    writeFileSync(target, 'target bytes stay\n');
    symlinkSync(target, log);
    expect(capSelfTickLog(log, { maxBytes: 4, keepBytes: 2 })).toEqual({ state: 'skipped' });
    expect(lstatSync(log).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('target bytes stay\n');
  });

  it('honours custom max/keep on a small file', () => {
    writeFileSync(log, lines(9, 'newest-line')); // 7-byte lines + tail
    const result = capSelfTickLog(log, { maxBytes: 40, keepBytes: 24 });
    expect(result.state).toBe('capped');
    const kept = readFileSync(log, 'utf8');
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(24);
    expect(kept.endsWith('newest-line\n')).toBe(true);
    expect(kept.startsWith('line-')).toBe(true); // starts on a boundary
  });

  it('a writer holding the log open in append mode keeps writing after the cap', () => {
    writeFileSync(log, lines(30, 'pre-cap-newest')); // ~250 bytes
    const fd = openSync(log, 'a'); // what launchd/systemd hold for the run
    try {
      const result = capSelfTickLog(log, { maxBytes: 64, keepBytes: 32 });
      expect(result.state).toBe('capped');
      writeSync(fd, 'appended-after-cap\n');
    } finally {
      closeSync(fd);
    }
    const kept = readFileSync(log, 'utf8');
    expect(kept.endsWith('appended-after-cap\n')).toBe(true);
    expect(kept).toContain('pre-cap-newest\n');
    expect(statSync(log).size).toBeLessThanOrEqual(32 + 'appended-after-cap\n'.length);
  });
});
