import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackWorkStatus, slackWorkStatusLine } from '../src/core/agents/slack-status.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-disk-528s-'));
  roots.push(root);
  const runsDir = join(root, 'runs');
  const busRoot = join(root, 'bus');
  const path = join(runsDir, 'queue', 'status.json');
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  const now = new Date('2026-11-13T13:30:00.000Z');
  const read = () => slackWorkStatusLine(readSlackWorkStatus({ runsDir, busRoot, now: () => now }), {});
  const write = (bytes: string) => writeFileSync(path, bytes);
  const unchangedRead = (bytes: string) => {
    write(bytes);
    const line = read();
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    return line;
  };
  return { path, read, unchangedRead };
}

const prefix = 'UNKNOWN; owner unknown; claim unknown; fleet as of ';
const tick = (value: string) => JSON.stringify({ last_tick: value, fixture: 'fake' }) + '\n';

describe('Slack status disk freshness (528s)', () => {
  it('uses each disk observation and forgets a good tick when evidence disappears or is invalid', () => {
    const { path, read, unchangedRead } = fixture();
    expect(unchangedRead(tick('2026-11-12T22:30:00Z'))).toBe(
      `${prefix}2026-11-12T22:30Z from fleet tick (stale, background only)`,
    );
    expect(unchangedRead(tick('2026-11-13T13:29:00Z'))).toBe(
      `${prefix}2026-11-13T13:29Z from fleet tick`,
    );
    expect(unchangedRead(tick('2026-11-13T13:30:00.001Z'))).toBe(`${prefix}unknown`);
    expect(unchangedRead('{ malformed')).toBe(`${prefix}unknown`);
    expect(unchangedRead(tick('not-a-date'))).toBe(`${prefix}unknown`);
    rmSync(path);
    expect(read()).toBe(`${prefix}unknown`);
    // A directory at the file path makes the source unreadable on all platforms,
    // including privileged test runners for which chmod-based fixtures can pass.
    mkdirSync(path);
    expect(read()).toBe(`${prefix}unknown`);
  });

  it('marks the first millisecond beyond the stale threshold as background', () => {
    const { unchangedRead } = fixture();
    expect(unchangedRead(tick('2026-11-13T13:15:00.000Z'))).toBe(
      `${prefix}2026-11-13T13:15Z from fleet tick`,
    );
    expect(unchangedRead(tick('2026-11-13T13:14:59.999Z'))).toBe(
      `${prefix}2026-11-13T13:14Z from fleet tick (stale, background only)`,
    );
  });
});
