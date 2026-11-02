import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditBets, betAuditOutStamp, readBetAudit } from '../src/core/fleet/bet-audit.js';
import { cmdFleetBetAudit, formatBetAudit } from '../src/cli/fleet-bet-audit.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0); // Nov 1 2026 12:00 UTC

/** Writes a runs-dir fixture and returns its root. */
function runsDir(files: Record<string, string | null> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'bet-audit-'));
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}
const dirs: string[] = [];
function make(files: Record<string, string | null>): string {
  const root = runsDir(files);
  dirs.push(root);
  return root;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('betAuditOutStamp', () => {
  it('reads the compact UTC timestamp from out-file names only', () => {
    expect(betAuditOutStamp('out.20261101T0800.txt')).toBe(Date.UTC(2026, 10, 1, 8, 0));
    expect(betAuditOutStamp('out.202611010800.txt')).toBe(Date.UTC(2026, 10, 1, 8, 0));
    expect(betAuditOutStamp('out.202611012359.txt')).toBe(Date.UTC(2026, 10, 1, 23, 59));
    expect(betAuditOutStamp('out.202611012460.txt')).toBeNull();
    expect(betAuditOutStamp('out.202611010800.log')).toBeNull();
    expect(betAuditOutStamp('out.txt')).toBeNull();
    expect(betAuditOutStamp('other.202611010800.txt')).toBeNull();
  });
});

describe('auditBets', () => {
  const outputs = [
    {
      name: 'out.20261101T0800.txt',
      text: [
        'BET phantom codex work LOSTONE drop it',
        'BET phantom claude mid QUEUED do work',
        'BET phantom codex work CLAIMED do work',
        'BET phantom devin work LAUNCHD do work',
        'FIXUP phantom FIXONE repair it',
        'BET phantom codex work PUBBED do work',
        'SLOTS codex 6',
        'noise line that is not an order',
      ].join('\n'),
    },
    {
      name: 'out.20261101T0900.txt',
      text: 'BET phantom codex work LOSTTWO drop it\nBET phantom codex work MRGDUP do work',
    },
  ];
  const queue = [
    '# router queue',
    '- READY RQ-QUEUEDQ8 (pool=codex, tier=work, repo=phantom): do work',
    '- CLAIMED RQ-CLAIMEDQ8 (pool=codex, tier=work, repo=phantom): worker=w1',
    '- HOLD RQ-LOSTONEQ8 (pool=codex): READY in prose is not a status',
    'Freeform note: - READY RQ-LOSTTWOQ8 must not count; only line heads do.',
  ].join('\n');
  const metrics = [
    JSON.stringify({ event: 'launch', job: 'RQ-LAUNCHDQ8', ts: '2026-11-01T08:05:00Z' }),
    JSON.stringify({ event: 'finish', job: 'RQ-FIXUP-FIXONEQ8', ts: '2026-11-01T08:30:00Z' }),
    JSON.stringify({ event: 'publish', job: 'RQ-PUBBEDQ8', url: 'https://github.com/ashlrai/phantom/pull/77', ts: '2026-11-01T09:05:00Z' }),
    JSON.stringify({ event: 'outcome', job: 'RQ-MRGDUPQ8', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/78', ts: '2026-11-01T10:05:00Z' }),
    'this is not json and must be skipped',
    JSON.stringify({ event: 'launch' }), // no job id: skipped
  ].join('\n');

  it('classifies every status, dedupes repeated ids, skips malformed metrics and prose', () => {
    const rows = auditBets({ outputs, queue, metrics, now: NOW, hours: 24 });
    const byId = new Map(rows.map(row => [row.id, row]));
    expect(rows.map(row => row.id).sort()).toEqual([
      'RQ-CLAIMEDQ8', 'RQ-FIXUP-FIXONEQ8', 'RQ-LAUNCHDQ8', 'RQ-LOSTONEQ8',
      'RQ-LOSTTWOQ8', 'RQ-MRGDUPQ8', 'RQ-PUBBEDQ8', 'RQ-QUEUEDQ8',
    ]);
    expect(byId.get('RQ-LOSTONEQ8')).toMatchObject({ status: 'lost', repo: 'phantom', lane: 'codex', issuedAt: '2026-11-01T08:00:00.000Z' });
    expect(byId.get('RQ-LOSTTWOQ8')).toMatchObject({ status: 'lost', issuedAt: '2026-11-01T09:00:00.000Z' });
    expect(byId.get('RQ-QUEUEDQ8')).toMatchObject({ status: 'queued' });
    expect(byId.get('RQ-CLAIMEDQ8')).toMatchObject({ status: 'claimed' });
    expect(byId.get('RQ-LAUNCHDQ8')).toMatchObject({ status: 'launched' });
    expect(byId.get('RQ-FIXUP-FIXONEQ8')).toMatchObject({ status: 'launched', lane: null });
    expect(byId.get('RQ-PUBBEDQ8')).toMatchObject({ status: 'published', url: 'https://github.com/ashlrai/phantom/pull/77' });
    expect(byId.get('RQ-MRGDUPQ8')).toMatchObject({ status: 'merged', url: 'https://github.com/ashlrai/phantom/pull/78' });
  });

  it('keeps the first issuedAt when an id is issued several times', () => {
    const repeated = [
      { name: 'out.20261101T0900.txt', text: 'BET phantom codex work DUP again' },
      { name: 'out.20261101T0700.txt', text: 'BET phantom codex work DUP first' },
    ];
    const rows = auditBets({ outputs: repeated, queue: null, metrics: null, now: NOW, hours: 24 });
    expect(rows).toEqual([{ id: 'RQ-DUPQ8', repo: 'phantom', lane: 'codex', issuedAt: '2026-11-01T07:00:00.000Z', status: 'lost', url: null }]);
  });

  it('windows by the timestamp in the out-file name, not the order text', () => {
    const stale = [{ name: 'out.20261020T0800.txt', text: 'BET phantom codex work OLD task' }];
    expect(auditBets({ outputs: stale, queue: 'RQ-OLDQ8', metrics: 'RQ-OLDQ8', now: NOW, hours: 24 })).toEqual([]);
    expect(auditBets({ outputs: stale, queue: 'RQ-OLDQ8', metrics: 'RQ-OLDQ8', now: NOW, hours: 24 * 30 })[0]!.status).toBe('lost');
    const future = [{ name: 'out.20261102T0800.txt', text: 'BET phantom codex work FUT task' }];
    expect(auditBets({ outputs: future, queue: null, metrics: null, now: NOW, hours: 48 })).toEqual([]);
  });

  it('does not let token prefixes pass as queue evidence', () => {
    const rows = auditBets({
      outputs: [{ name: 'out.20261101T0800.txt', text: 'BET phantom codex work PREFIX task' }],
      queue: '- READY RQ-PREFIXQ8-RETRY', metrics: null, now: NOW, hours: 24,
    });
    expect(rows[0]!.status).toBe('lost');
  });

  it('treats a metrics row of any event as consumed evidence', () => {
    const rows = auditBets({
      outputs: [{ name: 'out.20261101T0800.txt', text: 'BET phantom codex work SEEN task' }],
      queue: null,
      metrics: JSON.stringify({ event: 'precheck_skip', job: 'RQ-SEENQ8' }),
      now: NOW, hours: 24,
    });
    expect(rows[0]!.status).toBe('launched');
  });
});

describe('readBetAudit', () => {
  it('reads the three inputs under a real runs dir', async () => {
    const root = make({
      'supervisor/out.20261101T0800.txt': 'BET phantom codex work LOST drop it\nBET phantom codex work QUE do work',
      'queue/router-queue.md': '- READY RQ-QUEQ8 (pool=codex): do work',
      'metrics/jobs.jsonl': 'malformed\n' + JSON.stringify({ event: 'launch', job: 'RQ-OTHERQ8' }),
    });
    const report = await readBetAudit(root, { hours: 24, now: () => NOW });
    expect(report.schema).toBe('fleet.bet-audit.v1');
    expect(report.sources).toEqual({ supervisor: 'healthy', queue: 'healthy', metrics: 'healthy' });
    expect(report.rows.map(row => [row.id, row.status])).toEqual([['RQ-LOSTQ8', 'lost'], ['RQ-QUEQ8', 'queued']]);
    expect(report.summary).toMatchObject({ issued: 2, lost: 1, queued: 1 });
  });

  it('reports missing sources without failing', async () => {
    const root = make({});
    const report = await readBetAudit(root, { now: () => NOW });
    expect(report.rows).toEqual([]);
    expect(report.sources).toEqual({ supervisor: 'missing', queue: 'missing', metrics: 'missing' });
  });

  it('ignores non-out names and unreadable supervisor entries', async () => {
    const root = make({
      'supervisor/notes.txt': 'BET phantom codex work NOTE task',
      'supervisor/out.202611010800.json': 'BET phantom codex work JSON task',
      'queue/router-queue.md': '',
      'metrics/jobs.jsonl': '',
    });
    const report = await readBetAudit(root, { now: () => NOW });
    expect(report.rows).toEqual([]);
    expect(report.sources.supervisor).toBe('healthy');
  });
});

describe('formatBetAudit', () => {
  it('prints a table then the summary line', () => {
    const text = formatBetAudit([
      { id: 'RQ-AQ8', repo: 'phantom', lane: 'codex', issuedAt: '2026-11-01T08:00:00.000Z', status: 'lost', url: null },
      { id: 'RQ-FIXUP-BQ8', repo: 'phantom', lane: null, issuedAt: '2026-11-01T09:00:00.000Z', status: 'merged', url: 'https://github.com/ashlrai/phantom/pull/9' },
    ]);
    expect(text).toContain('RQ-AQ8');
    expect(text).toContain('lost');
    expect(text.trim().split('\n').at(-1)).toBe('2 issued, 1 lost, 1 merged');
    expect(formatBetAudit([]).trim().split('\n').at(-1)).toBe('0 issued, 0 lost, 0 merged');
  });
});

describe('cmdFleetBetAudit', () => {
  const stdout = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  it('prints parseable JSON and exits 0 even when jobs are lost', async () => {
    const root = make({
      'supervisor/out.20261101T0800.txt': 'BET phantom codex work PSMINIMATCHFIX drop it\nFIXUP phantom PLUGEVALCERTS repair it',
      'queue/router-queue.md': '',
      'metrics/jobs.jsonl': '',
    });
    const write = stdout();
    expect(await cmdFleetBetAudit(['--hours', '48', '--json', '--runs-dir', root], {}, { now: () => NOW })).toBe(0);
    const report = JSON.parse(String(write.mock.calls[0]![0]));
    expect(report.summary).toMatchObject({ issued: 2, lost: 2 });
    expect(report.rows.map((row: { id: string }) => row.id).sort()).toEqual(['RQ-FIXUP-PLUGEVALCERTSQ8', 'RQ-PSMINIMATCHFIXQ8']);
  });

  it('prints the table by default', async () => {
    const root = make({ 'supervisor/out.20261101T0800.txt': 'BET phantom codex work X task' });
    const write = stdout();
    expect(await cmdFleetBetAudit(['--runs-dir', root], {}, { now: () => NOW })).toBe(0);
    const text = write.mock.calls.map(call => String(call[0])).join('');
    expect(text).toContain('RQ-XQ8');
    expect(text).toContain('1 issued, 1 lost, 0 merged');
    expect(text).toContain('queue=missing');
  });

  it.each([
    ['--hours'], ['--hours', 'x'], ['--hours', '0'], ['--hours', '-3'], ['--hours', '5', '--hours', '6'],
    ['--runs-dir'], ['--runs-dir', 'relative/path'], ['--wat'], ['positional'], ['--json', '--json', '--bad'],
  ])('exits 2 on bad usage: %j', async (...args) => {
    expect(await cmdFleetBetAudit(args)).toBe(2);
  });

  it('exits 0 on --help without reading anything', async () => {
    const write = stdout();
    expect(await cmdFleetBetAudit(['--help'])).toBe(0);
    expect(String(write.mock.calls[0]![0])).toContain('bet-audit');
  });
});
