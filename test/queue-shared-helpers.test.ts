import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueVisitsSync } from '../src/cli/queue-visits-sync.js';
import { flagNouns } from '../src/core/queue/dupcheck.js';
import { readQueueVisits, recordQueueVisit } from '../src/core/queue/journal.js';
import { escapeRegExp, isEnoent, isQueueRecord, nonEmptyTrimmed, parseReadyQueueLine, parseUnixOrIsoMs } from '../src/core/queue/schema.js';
import { rewriteRouterLineStatus } from '../src/core/queue/supersede.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('queue shared helpers', () => {
  it('classifies plain records, trimmed strings, and ENOENT errors', () => {
    expect([isQueueRecord({ a: 1 }), isQueueRecord(null), isQueueRecord([]), isQueueRecord('x')]).toEqual([true, false, false, false]);
    expect([nonEmptyTrimmed('  RQ-1  '), nonEmptyTrimmed('   '), nonEmptyTrimmed(42)]).toEqual(['RQ-1', null, null]);
    expect(isEnoent(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
    expect([isEnoent({ code: 'ENOENT' }), isEnoent({ code: 'EACCES' }), isEnoent(null), isEnoent('ENOENT')]).toEqual([true, false, false, false]);
  });

  it('escapes regex metacharacters, parses Unix/ISO timestamps, and parses READY lines', () => {
    const literal = 'RQ-A.1[0]+(x)?$^*\\|';
    expect(new RegExp(`^${escapeRegExp(literal)}$`).test(literal)).toBe(true);
    expect(parseUnixOrIsoMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseUnixOrIsoMs('2026-11-17T12:00:00Z')).toBe(Date.parse('2026-11-17T12:00:00Z'));
    expect([Number.isNaN(parseUnixOrIsoMs(Infinity)), Number.isNaN(parseUnixOrIsoMs(null))]).toEqual([true, true]);
    expect(parseReadyQueueLine('- READY RQ-ALPHA (P1, enq=1700000000, repo=phantom): goal')).toEqual({ id: 'RQ-ALPHA', enqMs: 1_700_000_000_000 });
    expect(parseReadyQueueLine('- READY RQ-BETA (P2, repo=phantom): goal')).toEqual({ id: 'RQ-BETA', enqMs: null });
    expect(parseReadyQueueLine('- CLAIMED 09:00 worker RQ-GAMMA (repo=phantom): goal')).toBeNull();
  });

  it('rewrites router-queue statuses and extracts unique flag nouns', () => {
    expect(rewriteRouterLineStatus('  - READY RQ-OLD (P1, repo=phantom): scope', 'DROPPED')).toBe('  - DROPPED RQ-OLD (P1, repo=phantom): scope');
    expect(rewriteRouterLineStatus('- CLAIMED 09:15 dispatchd RQ-OLD (repo=phantom): scope', 'SUPERSEDED-BY-RQ-NEW')).toBe('- SUPERSEDED-BY-RQ-NEW 09:15 dispatchd RQ-OLD (repo=phantom): scope');
    expect(rewriteRouterLineStatus('# comment line', 'DROPPED')).toBe('# comment line');
    expect(flagNouns('Add --json and --dry-run, plus --json again; ignore foo--bar and --1bad.')).toEqual(['--json', '--dry-run']);
    expect(flagNouns('No flags here.')).toEqual([]);
  });

  it('writes visits via recordQueueVisit and batch-appends through visits-sync CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-shared-helpers-')); dirs.push(dir);
    const journalPath = join(dir, 'visits.jsonl');
    await recordQueueVisit({ id: 'RQ-1:a1', station: 'READY', pool: 'claude', arrivedAt: 1000 }, journalPath);
    expect(await readQueueVisits(journalPath)).toEqual([{ id: 'RQ-1:a1', station: 'READY', pool: 'claude', arrivedAt: 1000 }]);
    const runsDir = join(dir, 'runs'), jobsPath = join(runsDir, 'metrics', 'jobs.jsonl'), queuePath = join(runsDir, 'queue', 'router-queue.md'), cliJournal = join(dir, 'cli-visits.jsonl');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true }); mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(jobsPath, `${JSON.stringify({ event: 'enqueue', job: 'RQ-2', lane: 'codex-personal', ts: '2026-11-05T14:00:00Z' })}\n${JSON.stringify({ event: 'launch', job: 'RQ-2', lane: 'codex-personal', ts: '2026-11-05T14:00:30Z' })}\n`);
    writeFileSync(queuePath, '- READY RQ-3 (P1, pool=claude, enq=1793887200): task\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueVisitsSync(['--jobs', jobsPath, '--queue', queuePath, '--journal', cliJournal, '--apply', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ applied: true, plan: { appended: 3 } });
    expect(readFileSync(cliJournal, 'utf8').trim().split('\n')).toHaveLength(3);
  });
});
