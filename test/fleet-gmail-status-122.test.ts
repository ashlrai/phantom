import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetGmailStatus } from '../src/cli/fleet-gmail-status.js';
import { gmailArchivePlanLatestPath, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string;
let runsDir: string;

const T0 = Date.parse('2026-11-10T12:00:00.000Z');
const NOW = T0 + 90 * 60 * 1000;

function seedTriage(): void {
  writeGmailTriageLatest(runsDir, {
    dir: join(root, 'accounts', 'Legacy Inbox'),
    scanned: 120, updates: 80, drafted: 3, review: 4, failed: 1,
    unreadInSample: 95, target: 100, archiveCandidateCount: 12,
    now: () => new Date(T0),
  });
}

function seedArchivePlans(): void {
  writeGmailArchivePlanLatest(runsDir, {
    inbox: 'alpha', unread: 90, target: 100, archiveCount: 10,
    topSenders: [{ sender: 'sam@people.test', count: 10 }],
    now: () => new Date(T0 + 1000),
  });
  writeGmailArchivePlanLatest(runsDir, {
    inbox: 'beta', unread: 40, target: 50, archiveCount: 5,
    topSenders: [{ sender: 'pat@people.test', count: 5 }],
    now: () => new Date(T0 + 2000),
  });
}

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-status-'));
  runsDir = join(root, 'runs');
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

type Out = {
  schema: string;
  at: string;
  countsDescribe: string;
  liveInbox: string;
  archiveExecution: string;
  triage: {
    state: string; at: string | null; ageSeconds: number | null; label: string | null;
    counts: Record<string, number> | null;
  };
  archivePlans: {
    state: string; planCount: number;
    plans: { inbox: string; at: string | null; ageSeconds: number | null; unread: number; target: number; archiveCount: number }[];
  };
};

async function run(args: string[], opts: { runsDir?: string; now?: () => number } = {}): Promise<{
  code: number; out: Out | null; logs: string[]; errors: string[];
}> {
  log.mockClear(); err.mockClear();
  const code = await cmdFleetGmailStatus(args, { now: () => NOW, ...opts });
  const logs = log.mock.calls.map(c => String(c[0]));
  const json = logs.filter(l => l.startsWith('{')).at(-1);
  return { code, out: json ? JSON.parse(json) as Out : null, logs, errors: err.mock.calls.map(c => String(c[0])) };
}

describe('fleet gmail-status', () => {
  it('reports saved triage counts and two archive inbox plans with deterministic ages', async () => {
    seedTriage();
    seedArchivePlans();
    const r = await run(['--json', '--runs-dir', runsDir]);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    const out = r.out!;
    expect(out.schema).toBe('fleet.gmail-status.v1');
    expect(out.countsDescribe).toBe('saved-export-samples');
    expect(out.liveInbox).toBe('unknown');
    expect(out.archiveExecution).toBe('unverified');
    expect(out.at).toBe(new Date(NOW).toISOString());

    expect(out.triage.state).toBe('present');
    expect(out.triage.label).toBe('Legacy Inbox');
    expect(out.triage.at).toBe(new Date(T0).toISOString());
    expect(out.triage.ageSeconds).toBe(5400);
    expect(out.triage.counts).toEqual({
      scanned: 120, updates: 80, drafted: 3, review: 4, failed: 1,
      unreadInSample: 95, target: 100, archiveCandidateCount: 12,
    });

    expect(out.archivePlans.state).toBe('present');
    expect(out.archivePlans.planCount).toBe(2);
    expect(out.archivePlans.plans.map(p => p.inbox)).toEqual(['alpha', 'beta']);
    expect(out.archivePlans.plans[0]).toMatchObject({
      at: new Date(T0 + 1000).toISOString(), ageSeconds: 5399,
      unread: 90, target: 100, archiveCount: 10,
    });
    expect(out.archivePlans.plans[1]).toMatchObject({
      at: new Date(T0 + 2000).toISOString(), ageSeconds: 5398,
      unread: 40, target: 50, archiveCount: 5,
    });
  });

  it('emits no senders, paths, subjects, ids or bodies', async () => {
    seedTriage();
    seedArchivePlans();
    const banned = ['@', 'topSenders', 'sender', runsDir, root, 'accounts', 'people.test', 'subject', 'body', 'message'];
    const json = await run(['--json', '--runs-dir', runsDir]);
    expect(json.code).toBe(0);
    for (const word of banned) expect(JSON.stringify(json.out), word).not.toContain(word);
    const human = await run(['--runs-dir', runsDir]);
    const humanText = human.logs.join('\n');
    for (const word of banned) expect(humanText, word).not.toContain(word);
    expect(humanText).toContain('saved export samples');
    expect(humanText).toContain('live inbox state unknown');
    expect(humanText).toContain('archive execution unverified');
    expect(humanText).toContain('"alpha"');
    expect(humanText).toContain('"Legacy Inbox"');
  });

  it('missing evidence is a valid observable state and the sections are independent', async () => {
    const empty = await run(['--json', '--runs-dir', runsDir]);
    expect(empty.code).toBe(0);
    expect(empty.out!.triage).toEqual({ state: 'missing', at: null, ageSeconds: null, label: null, counts: null });
    expect(empty.out!.archivePlans).toEqual({ state: 'missing', planCount: 0, plans: [] });
    expect(empty.out!.liveInbox).toBe('unknown');

    seedArchivePlans();
    const onlyArchive = await run(['--json', '--runs-dir', runsDir]);
    expect(onlyArchive.code).toBe(0);
    expect(onlyArchive.out!.triage.state).toBe('missing');
    expect(onlyArchive.out!.archivePlans.planCount).toBe(2);

    rmSync(runsDir, { recursive: true, force: true });
    seedTriage();
    const onlyTriage = await run(['--json', '--runs-dir', runsDir]);
    expect(onlyTriage.code).toBe(0);
    expect(onlyTriage.out!.triage.state).toBe('present');
    expect(onlyTriage.out!.archivePlans.state).toBe('missing');
    expect(onlyTriage.out!.archivePlans.planCount).toBe(0);
  });

  it('treats corrupt evidence files as missing rather than failing', async () => {
    mkdirSync(join(runsDir, 'comms'), { recursive: true });
    writeFileSync(gmailTriageLatestPath(runsDir), 'not json{{{');
    writeFileSync(gmailArchivePlanLatestPath(runsDir), '{"schema":"fleet.gmail-archive-plan-latest.v1","plans":"nope"}');
    const r = await run(['--json', '--runs-dir', runsDir]);
    expect(r.code).toBe(0);
    expect(r.out!.triage.state).toBe('missing');
    expect(r.out!.archivePlans.state).toBe('missing');
  });

  it('keeps invalid timestamps unknown while still reporting counts', async () => {
    mkdirSync(join(runsDir, 'comms'), { recursive: true });
    writeFileSync(gmailTriageLatestPath(runsDir), `${JSON.stringify({
      schema: 'fleet.gmail-triage-latest.v1', at: 'not-a-date', dir: 'odd',
      scanned: 7, updates: 5, drafted: 0, review: 1, failed: 0,
      unreadInSample: 6, target: 10, archiveCandidateCount: 2,
    })}\n`);
    writeFileSync(gmailArchivePlanLatestPath(runsDir), `${JSON.stringify({
      schema: 'fleet.gmail-archive-plan-latest.v1',
      plans: [{ inbox: 'odd', at: 'also-not-a-date', unread: 3, target: 10, archiveCount: 1, topSenders: [] }],
    })}\n`);
    const r = await run(['--json', '--runs-dir', runsDir]);
    expect(r.code).toBe(0);
    expect(r.out!.triage.state).toBe('present');
    expect(r.out!.triage.ageSeconds).toBeNull();
    expect(r.out!.triage.counts!.scanned).toBe(7);
    expect(r.out!.archivePlans.plans[0]!.ageSeconds).toBeNull();
    expect(r.out!.archivePlans.plans[0]!.archiveCount).toBe(1);
  });

  it('rejects unknown flags and positional arguments with exit 2', async () => {
    for (const args of [['--bogus'], ['extra'], ['--runs-dir'], ['--runs-dir', '--json'], ['--json', 'x']]) {
      const r = await run(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.out).toBeNull();
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('--help prints usage and exits 0 without reading stores', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.logs.join('\n')).toContain('Usage: ashlr fleet gmail-status');
    expect(r.out).toBeNull();
  });

  it('dispatches through the fleet convention loader as fleet gmail-status', async () => {
    seedTriage();
    seedArchivePlans();
    log.mockClear();
    const code = await cmdFleet(['gmail-status', '--json', '--runs-dir', runsDir], {
      'gmail-status': () => import('../src/cli/fleet-gmail-status.js'),
    });
    expect(code).toBe(0);
    const logs = log.mock.calls.map(c => String(c[0]));
    const json = logs.filter(l => l.startsWith('{')).at(-1);
    expect(json).toBeDefined();
    const out = JSON.parse(json!) as Out;
    expect(out.schema).toBe('fleet.gmail-status.v1');
    expect(out.triage.state).toBe('present');
    expect(out.archivePlans.planCount).toBe(2);
  });
});
