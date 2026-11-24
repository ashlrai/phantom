import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { burnLines, cmdFleetBurn } from '../src/cli/fleet-burn.js';
import { countStarts, parseUsageSamples, readBurnWho, whoIsBurning } from '../src/core/usage/burn-who.js';

const NOW = Date.parse('2026-11-21T07:48:00Z');
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
/** Twelve readings over six hours that climb `perHour` points an hour up to `usedNow` points. */
const climb = (usedNow: number, perHour: number) =>
  JSON.stringify({ samples: Array.from({ length: 13 }, (_, i) => ({ ts: iso(6 - i * 0.5), claude_weekly_frac: (usedNow - perHour * (6 - i * 0.5)) / 100 })) });
const status = (hoursToReset: number, extra: Record<string, unknown> = {}) => ({
  budget: { claude: { use_it_all: { known: true, stale: false, reset_at: new Date(NOW + hoursToReset * HOUR).toISOString(), ...extra } } },
});
const run = (extra: Partial<Parameters<typeof whoIsBurning>[0]>) => whoIsBurning({ usageJson: null, status: null, now: NOW, timeZone: 'UTC', ...extra });

describe('whoIsBurning', () => {
  it('on pace: lasts to the reset', () => {
    const r = run({ usageJson: climb(20, 0.5), status: status(159) });
    expect(r.state).toBe('on-pace');
    expect(r.paceBasis).toBe('1h');
    expect(r.paceNow).toBeCloseTo(0.5, 1);
    expect(r.evenPacePercent).toBeCloseTo(5.4, 1);
    expect(r.sentence).toBe('Claude is at 20%, spending about 0.5 points an hour; that lasts to its reset. No job starts found in the last 6 hours.');
  });

  it('ahead of pace: says when it empties and how long before the reset', () => {
    const r = run({ usageJson: climb(63, 6), status: status(159) });
    expect(r.state).toBe('ahead');
    expect(r.paceNow).toBeCloseTo(6, 1);
    expect(Date.parse(r.emptyAt!)).toBeCloseTo(NOW + (37 / 6) * HOUR, -4);
    expect(r.idleHours).toBeGreaterThan(150);
    expect(r.sentence).toMatch(/^Claude is at 63%, spending about 6 points an hour; empty about 1:58 PM today, 6 days before its reset\./);
  });

  it('no samples: unknown, never a guess', () => {
    const r = run({ usageJson: null, status: status(159) });
    expect(r.state).toBe('unknown');
    expect(r.emptyAt).toBeNull();
    expect(r.paceNow).toBeNull();
    expect(r.sentence).toBe('Claude usage is unknown: no usage reading.');
    expect(run({ usageJson: '{"samples":[]}', status: null }).state).toBe('unknown');
    expect(run({ usageJson: 'not json', status: status(10) }).reason).toBe('no usage reading');
  });

  it('too few samples and no reported pace: unknown pace, keeps the reading', () => {
    const r = run({ usageJson: JSON.stringify({ ts: iso(0.1), claude_weekly_frac: 0.63 }), status: status(159) });
    expect(r.state).toBe('unknown');
    expect(r.usedPercent).toBe(63);
    expect(r.sentence).toContain('not enough readings to measure the pace');
    expect(r.sentence).toContain('last read at 63%');
  });

  it('falls back to the pace dispatchd reports when samples are too few', () => {
    const r = run({ usageJson: JSON.stringify({ ts: iso(0.1), claude_weekly_frac: 0.5 }), status: status(100, { burn_pct_per_hour: 1 }) });
    expect(r.paceBasis).toBe('reported');
    expect(r.state).toBe('ahead');
  });

  it('ignores a stale dispatchd reading and a reading from the future', () => {
    const stale = { budget: { claude: { use_it_all: { known: true, stale: true, reset_at: iso(-5), burn_pct_per_hour: 9 } } } };
    expect(run({ usageJson: climb(40, 1), status: stale }).reason).toBe('reset time unknown');
    expect(parseUsageSamples(JSON.stringify([{ ts: iso(1), claude_weekly_frac: -1 }, { ts: 'later', claude_weekly_frac: 0.2 }]))).toEqual([]);
  });

  it('a pool nobody is spending is idle', () => {
    expect(run({ usageJson: climb(40, 0), status: status(100) }).state).toBe('idle');
  });
});

describe('consumer split', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  // dispatch-events.log stamps are local wall time.
  const at = (h: number) => { const d = new Date(NOW - h * HOUR); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const jobs = [
    { ts: iso(1), event: 'launch', lane: 'claude', job: 'RQ-DOCSFIX1' },
    { ts: iso(2), event: 'launch', lane: 'claude', job: 'RQ-DOCSFIX2' },
    { ts: iso(2), event: 'launch', lane: 'claude', job: 'RQ-CL-DOCS-1' }, // counted from the loop log instead
    { ts: iso(2), event: 'launch', lane: 'codex-local', job: 'RQ-OTHER' },
    { ts: iso(9), event: 'launch', lane: 'claude', job: 'RQ-OLD' }, // outside 6 h
    { ts: iso(1), event: 'finish', lane: 'claude', job: 'RQ-DOCSFIX1' },
  ].map(row => JSON.stringify(row)).join('\n') + '\nnot json\n';
  const docsLog = ['start docs-1', 'working', 'done', 'start docs-2', 'start docs-3', 'start docs-4'].map((line, i) => `${new Date(NOW - (i + 1) * 0.5 * HOUR).toISOString()} ${line}`).join('\n')
    + `\n${new Date(NOW - 8 * HOUR).toISOString()} start long ago`;
  const events = `${at(1)} OPUS-LEADER rc=0\n${at(3)} OPUS-LEADER rc=1\n${at(1)} LEADER rc=0\n${at(10)} OPUS-LEADER rc=0\n`;

  it('counts job starts per consumer, most first, with shares', () => {
    const rows = countStarts({ jobsText: jobs, loopLogs: new Map([['docs', docsLog], ['desk', '']]), eventsText: events }, NOW);
    const by = Object.fromEntries(rows.map(r => [r.name, r]));
    expect(by['docs loop']!.starts).toBe(4);
    expect(by['dispatchd claude lane']!.starts).toBe(2);
    expect(by['leader passes']!.starts).toBe(2);
    expect(by['desk loop']!.starts).toBe(0);
    expect(rows[0]!.name).toBe('docs loop');
    expect(by['docs loop']!.sharePercent).toBe(50);
    expect(by['docs loop']!.startsPerHour).toBeCloseTo(0.7, 1);
  });

  it('names the top consumer in the sentence and says it is a start count', () => {
    const r = run({ usageJson: climb(63, 6), status: status(159), jobsText: jobs, loopLogs: new Map([['docs', docsLog]]), eventsText: events });
    expect(r.sentence).toMatch(/Most starts: docs loop \(0\.7\/h\)\.$/);
    const text = burnLines(r).join('\n');
    expect(text).toContain('Job starts, last 6 h (a count of job starts, not tokens)');
    expect(text).toContain('docs loop: 4 (50%, 0.7/h)');
    expect(text).toContain('Even pace:');
  });
});

describe('phm fleet burn', () => {
  it('reads a runs directory and prints one sentence first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'burn-'));
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'devin-cloud-in', 'claude-loop'), { recursive: true });
    await writeFile(join(dir, 'fable-usage.json'), climb(63, 6));
    await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({ ...status(159) }));
    await writeFile(join(dir, 'devin-cloud-in', 'claude-loop', 'docs.log'), `${new Date(NOW - HOUR).toISOString()} start docs-1\n`);
    const r = await readBurnWho({ runsDir: dir, now: NOW, timeZone: 'UTC' });
    expect(r.state).toBe('ahead');
    expect(r.consumers.find(c => c.name === 'docs loop')?.starts).toBe(1);
    const empty = await readBurnWho({ runsDir: join(dir, 'missing'), now: NOW });
    expect(empty.state).toBe('unknown');
  });

  it('prints plain text or json and rejects other pools', async () => {
    const read = async () => run({ usageJson: null, status: null });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetBurn(['--pool', 'claude'], { read })).toBe(0);
    expect(String(log.mock.calls[0]![0]).split('\n')[0]).toBe('Claude usage is unknown: no usage reading.');
    expect(await cmdFleetBurn(['--json'], { read })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]![0])).schema).toBe('usage.burn.v1');
    expect(await cmdFleetBurn(['--pool', 'codex'], { read })).toBe(2);
    expect(await cmdFleetBurn(['--help'], { read })).toBe(0);
    log.mockRestore(); err.mockRestore();
  });
});
