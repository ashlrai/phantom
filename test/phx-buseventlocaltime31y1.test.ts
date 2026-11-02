import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BusFeedEvent } from '../src/core/fleet/bus-feed.js';

// Node's timezone is process-global, and changing TZ in a Vitest worker is not reliable.
// A separate process keeps the timezone fixed without affecting other tests.
function inNewYork(input: string, runsDir?: string): BusFeedEvent[] {
  const script = `
    import { readFileSync } from 'node:fs';
    import { parseDispatchEvents, readFleetBusFeed } from './src/core/fleet/bus-feed.ts';
    const input = readFileSync(0, 'utf8');
    const events = process.argv[1]
      ? (await readFleetBusFeed({ runsDir: process.argv[1], hopsFile: process.argv[1] + '/missing-hops' })).events
      : parseDispatchEvents(input);
    process.stdout.write(JSON.stringify(events));
  `;
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ...(runsDir ? [runsDir] : [])], {
    input, encoding: 'utf8', env: { HOME: process.env.HOME, TZ: 'America/New_York' },
  });
  return JSON.parse(output) as BusFeedEvent[];
}

describe('local dispatch wall times in the bus feed', () => {
  it('preserves display text and resolves standard and daylight offsets', () => {
    const rows = inNewYork([
      '2026-01-02 00:04:05 LAUNCH winter',
      '2026-07-04 12:03:02 INBOX summer',
      '2026-03-08 01:59:59 LAUNCH before transition',
      '2026-03-08 03:00:00 INBOX after transition',
    ].join('\n'));
    expect(rows.map(({ at, atIso, kind, text }) => ({ at, atIso, kind, text }))).toEqual([
      { at: '2026-01-02 00:04:05', atIso: '2026-01-02T00:04:05-05:00', kind: 'launch', text: 'LAUNCH winter' },
      { at: '2026-07-04 12:03:02', atIso: '2026-07-04T12:03:02-04:00', kind: 'inbox', text: 'INBOX summer' },
      { at: '2026-03-08 01:59:59', atIso: '2026-03-08T01:59:59-05:00', kind: 'launch', text: 'LAUNCH before transition' },
      { at: '2026-03-08 03:00:00', atIso: '2026-03-08T03:00:00-04:00', kind: 'inbox', text: 'INBOX after transition' },
    ]);
    expect(rows.map((row) => new Date(row.atIso!).toISOString())).toEqual([
      '2026-01-02T05:04:05.000Z', '2026-07-04T16:03:02.000Z',
      '2026-03-08T06:59:59.000Z', '2026-03-08T07:00:00.000Z',
    ]);
  });

  it('rejects malformed calendar values and the spring-forward gap', () => {
    const rows = inNewYork([
      '2026-02-29 12:00:00 LAUNCH invalid leap day',
      '2026-04-31 12:00:00 LAUNCH invalid day',
      '2026-13-01 12:00:00 LAUNCH invalid month',
      '2026-01-01 24:00:00 LAUNCH invalid hour',
      '2026-01-01 12:60:00 LAUNCH invalid minute',
      '2026-01-01 12:00:60 LAUNCH invalid second',
      '2026-03-08 02:30:00 INBOX nonexistent',
      '2026-1-01 12:00:00 LAUNCH malformed',
      '2024-02-29 12:00:00 LAUNCH valid leap day',
    ].join('\n'));
    expect(rows.map((row) => row.at)).toEqual(['2024-02-29 12:00:00']);
  });

  it('leaves fall-back ambiguity to the host date resolver', () => {
    const [row] = inNewYork('2026-11-01 01:30:00 INBOX repeated wall time');
    expect(row.at).toBe('2026-11-01 01:30:00');
    // The log has no offset, so either occurrence is compatible with the wall time.
    expect(['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00']).toContain(row.atIso);
  });

  it('keeps file order even when timestamps are not chronological', () => {
    const rows = inNewYork([
      '2026-07-04 12:00:01 LAUNCH later',
      '2026-07-04 12:00:00 INBOX earlier',
      '2026-07-04 12:00:02 ORCH-LEADER last',
    ].join('\n'));
    expect(rows.map((row) => row.text)).toEqual(['LAUNCH later', 'INBOX earlier', 'ORCH-LEADER last']);
    expect(rows.map((row) => row.atIso)).toEqual([
      '2026-07-04T12:00:01-04:00', '2026-07-04T12:00:00-04:00', '2026-07-04T12:00:02-04:00',
    ]);
  });

  it('exposes local timestamps through the file-backed feed', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'bus-local-time-'));
    try {
      await writeFile(join(runsDir, 'dispatch-events.log'), '2026-10-31 23:51:00 LAUNCH shared stream\n2026-10-31 23:51:01 INBOX desktop\n');
      const rows = inNewYork('', runsDir);
      expect(rows.map(({ at, atIso }) => ({ at, atIso }))).toEqual([
        { at: '2026-10-31 23:51:00', atIso: '2026-10-31T23:51:00-04:00' },
        { at: '2026-10-31 23:51:01', atIso: '2026-10-31T23:51:01-04:00' },
      ]);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
