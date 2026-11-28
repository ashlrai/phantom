import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { incidentLedgerBacklogItems, parseIncidentLedger } from '../src/core/improve/incident-ledger-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-incidentledger-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const iso = (days: number, hours = 0): string => new Date(NOW_MS - days * 86_400_000 + hours * 3_600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface Entry {
  fingerprint?: string;
  jobId?: string;
  attempt?: number;
  repo?: string;
  severity?: string;
  kind?: string;
  source?: string;
  title?: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: number;
  receiptedAt?: string;
  targetRevision?: string;
}

let fpSeq = 0;
/** One incidents.v1.json entry row, contract-valid by default. */
const entry = (over: Entry = {}): Entry => {
  fpSeq += 1;
  const fingerprint = (fpSeq.toString(16).padStart(2, '0') + 'a'.repeat(10)).slice(0, 12);
  return {
    fingerprint,
    jobId: `INC-${fingerprint}`,
    attempt: 1,
    repo: REPO,
    severity: 'sev3',
    kind: 'error',
    source: 'monitor',
    title: 'worker disk pressure',
    firstSeen: iso(3),
    lastSeen: iso(1),
    count: 7,
    ...over,
  };
};

const ledger = (entries: Array<Entry | Record<string, unknown>>, admissions: unknown[] = []): string =>
  JSON.stringify({ schema: 'incident.v1', entries, admissions }) + '\n';

const writeLedger = (doc: string | Array<Entry | Record<string, unknown>>): string => {
  const file = path.join(home, 'incidents.v1.json');
  fs.writeFileSync(file, typeof doc === 'string' ? doc : ledger(doc));
  return file;
};

/** Two fingerprints the pipeline re-opened after closed fixes — the non-converging fix loop. */
const regressedDoc = (): Entry[] => [
  entry({ attempt: 2, jobId: 'INC-aaaabbbbcccc-2', count: 12 }),
  entry({ attempt: 3, jobId: 'INC-ddddeeeeffff-3', severity: 'sev2', count: 30 }),
];

describe('incidentLedgerBacklogItems', () => {
  it('turns re-opened incidents into a valid priority-3 backlog item', async () => {
    const items = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(regressedDoc()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^incident-ledger-regressed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'incident-ledger' });
    expect(item.prompt).toContain('2 fingerprint(s) recorded attempt ≥ 2');
    expect(item.prompt).toContain('INC-aaaabbbbcccc-2');
    expect(item.prompt).toContain('INC-ddddeeeeffff-3');
    expect(item.prompt).toContain('incidents.v1.json');
    expect(item.prompt).toContain('pipeline.ts');
    expect(item.prompt).toContain('no-change');
  });

  it('emits the regressed cell on the single-fingerprint fourth-attempt bar', async () => {
    const items = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ attempt: 4, jobId: 'INC-aaaabbbbcccc-4', count: 40 })]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-ledger-regressed-/);
    // One re-opened fingerprint below the fourth-attempt bar stays quiet.
    const quiet = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ attempt: 3, jobId: 'INC-aaaabbbbcccc-3' })]),
    });
    expect(quiet).toEqual([]);
    // First-attempt rows never fold, however many there are.
    const fresh = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry(), entry(), entry()]),
    });
    expect(fresh).toEqual([]);
  });

  it('turns an aged un-receipted sev1 into a critical-open item', async () => {
    const items = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ severity: 'sev1', kind: 'log-anomaly', firstSeen: iso(4), lastSeen: iso(1), count: 3 })]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^incident-ledger-critical-open-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'incident-ledger' });
    expect(item.prompt).toContain('1 sev1 and 0 sev2');
    expect(item.prompt).toContain('receiptedAt');
    expect(item.prompt).toContain('phm queue show');
    expect(item.prompt).toContain('no-change');
  });

  it('needs two aged un-receipted sev2s and honours receipt, age and liveness bars', async () => {
    const oneSev2 = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ severity: 'sev2', firstSeen: iso(4), lastSeen: iso(1) })]),
    });
    expect(oneSev2).toEqual([]);
    const twoSev2 = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ severity: 'sev2', firstSeen: iso(4), lastSeen: iso(1) }),
        entry({ severity: 'sev2', firstSeen: iso(3), lastSeen: iso(0) }),
      ]),
    });
    expect(twoSev2).toHaveLength(1);
    expect(twoSev2[0]!.id).toMatch(/^incident-ledger-critical-open-/);
    // A recorded receipt closes the question regardless of sightings.
    const receipted = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ severity: 'sev1', firstSeen: iso(4), lastSeen: iso(1), receiptedAt: iso(2) })]),
    });
    expect(receipted).toEqual([]);
    // First seen inside the age bar is a fresh incident, not an aged one.
    const young = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ severity: 'sev1', firstSeen: iso(0.5), lastSeen: iso(0) })]),
    });
    expect(young).toEqual([]);
    // Last sighting older than the liveness bar means the signal went quiet.
    const stale = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ severity: 'sev1', firstSeen: iso(6), lastSeen: iso(3) })]),
    });
    expect(stale).toEqual([]);
    // sev3/sev4 never spend a job — recorded volume is not critical-open evidence.
    const low = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ severity: 'sev3', firstSeen: iso(5), lastSeen: iso(1) }),
        entry({ severity: 'sev4', firstSeen: iso(5), lastSeen: iso(1) }),
      ]),
    });
    expect(low).toEqual([]);
  });

  it('turns contract-drifted entries into an unparsed item on the fleet repo only', async () => {
    const drifted = [
      { fingerprint: 'not-hex!!', jobId: 'INC-aaaabbbbcccc', attempt: 1, repo: REPO, severity: 'sev3', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
      { fingerprint: 'aaaabbbbcccc', jobId: 'WRONG-PREFIX', attempt: 1, repo: REPO, severity: 'sev3', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
      { fingerprint: 'bbbbaaaacccc', jobId: 'INC-bbbaaaacccc', attempt: 0, repo: REPO, severity: 'sev3', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
    ];
    const items = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(drifted), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^incident-ledger-unparsed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('holds 3 entries');
    expect(item.prompt).toContain('field contract');
    // Drift is install-wide evidence: a non-fleet target inherits nothing.
    const other = await incidentLedgerBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: writeLedger(drifted), now: NOW });
    expect(other).toEqual([]);
    // Below the drift bar stays quiet.
    const few = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(drifted.slice(0, 2)), now: NOW });
    expect(few).toEqual([]);
  });

  it('emits all applicable buckets in a fixed order and honours the limit', async () => {
    const doc: Array<Entry | Record<string, unknown>> = [
      ...regressedDoc(),
      entry({ severity: 'sev1', firstSeen: iso(4), lastSeen: iso(1) }),
      { fingerprint: 'ccccddddeeee', jobId: 'BAD', attempt: 'x', repo: REPO, severity: 'sev9', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
      { fingerprint: 'ddddccccbbbb', jobId: 'ALSO-BAD', attempt: 1, repo: REPO, severity: 'sev3', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
      { fingerprint: 'eeeebbbbcccc', jobId: 'THR-BAD', attempt: 1, repo: REPO, severity: 'sev3', kind: 'error', source: 'm', title: 't', firstSeen: iso(2), lastSeen: iso(1), count: 1 },
    ];
    const items = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(doc), now: NOW });
    expect(items).toHaveLength(3);
    expect(items[0]!.id).toMatch(/^incident-ledger-regressed-/);
    expect(items[1]!.id).toMatch(/^incident-ledger-critical-open-/);
    expect(items[2]!.id).toMatch(/^incident-ledger-unparsed-/);
    const one = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(doc), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('matches the target repo exactly, case-insensitively, and by bare name only', async () => {
    const regressed = (): Entry[] => [
      entry({ repo: 'AshlrAI/Phantom', attempt: 2, jobId: 'INC-aaaabbbbcccc-2' }),
      entry({ repo: 'ashlrai/phantom', attempt: 2, jobId: 'INC-ddddeeeeffff-2' }),
    ];
    const items = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(regressed()), now: NOW });
    expect(items).toHaveLength(1);
    // The pipeline's bare-name form names this install's own repository.
    const bare = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ repo: 'phantom', attempt: 2, jobId: 'INC-aaaabbbbcccc-2' }), entry({ repo: 'phantom', attempt: 2, jobId: 'INC-ddddeeeeffff-2' })]),
    });
    expect(bare).toHaveLength(1);
    // Another owner's same-named repo and a different bare name never fold.
    const foreignOwner = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([entry({ repo: 'other/phantom', attempt: 2, jobId: 'INC-aaaabbbbcccc-2' }), entry({ repo: 'other/phantom', attempt: 2, jobId: 'INC-ddddeeeeffff-2' })]),
    });
    expect(foreignOwner).toEqual([]);
    const otherRepo = await incidentLedgerBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: writeLedger(regressed()), now: NOW });
    expect(otherRepo).toEqual([]);
  });

  it('anchors the window on lastSeen and drops stale or future-skewed rows', async () => {
    // Old firstSeen but a recent lastSeen still counts — the pipeline refreshes lastSeen on every sighting.
    const recent = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ attempt: 2, jobId: 'INC-aaaabbbbcccc-2', firstSeen: iso(30), lastSeen: iso(1) }),
        entry({ attempt: 2, jobId: 'INC-ddddeeeeffff-2', firstSeen: iso(20), lastSeen: iso(2) }),
      ]),
    });
    expect(recent).toHaveLength(1);
    // Last sightings outside the 7-day window contribute nothing.
    const stale = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ attempt: 5, jobId: 'INC-aaaabbbbcccc-5', firstSeen: iso(30), lastSeen: iso(8) }),
        entry({ attempt: 2, jobId: 'INC-ddddeeeeffff-2', firstSeen: iso(30), lastSeen: iso(9) }),
      ]),
    });
    expect(stale).toEqual([]);
    // Stamps beyond the one-minute future skew are corrupt or replayed evidence.
    const future = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ attempt: 2, jobId: 'INC-aaaabbbbcccc-2', lastSeen: new Date(NOW_MS + 3_600_000).toISOString() }),
        entry({ attempt: 2, jobId: 'INC-ddddeeeeffff-2', lastSeen: new Date(NOW_MS + 7_200_000).toISOString() }),
      ]),
    });
    expect(future).toEqual([]);
  });

  it('yields nothing for a missing, malformed or foreign-schema document', async () => {
    expect(await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: path.join(home, 'no-such.json'), now: NOW })).toEqual([]);
    for (const doc of [
      'not json',
      '{"schema":"other.v1","entries":[],"admissions":[]}',
      '{"schema":"incident.v1","entries":{}}',
      '{"schema":"incident.v1","entries":[]}',
      '[]',
      '',
    ]) {
      expect(await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: writeLedger(doc), now: NOW })).toEqual([]);
    }
    expect(await incidentLedgerBacklogItems({ repo: '', ledgerPath: writeLedger(regressedDoc()), now: NOW })).toEqual([]);
    expect(await incidentLedgerBacklogItems({ repo: 'not-a-repo', ledgerPath: writeLedger(regressedDoc()), now: NOW })).toEqual([]);
  });

  it('parseIncidentLedger counts drifted rows and rejects foreign documents whole', () => {
    const parsed = parseIncidentLedger(ledger([entry(), { bogus: true }, entry({ attempt: 2 })]));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.drifted).toBe(1);
    expect(parseIncidentLedger('not json')).toEqual({ rows: [], drifted: 0 });
    expect(parseIncidentLedger('{"schema":"other.v1","entries":[{}],"admissions":[]}')).toEqual({ rows: [], drifted: 0 });
    // A targetRevision-bearing row validates; a malformed one drifts.
    const rev = 'a'.repeat(40);
    const withRev = parseIncidentLedger(ledger([
      entry({ targetRevision: rev, jobId: `INC-${'b'.repeat(24)}` }),
      entry({ targetRevision: 'xyz', jobId: 'INC-aaaabbbbcccc' }),
    ]));
    expect(withRev.rows).toHaveLength(1);
    expect(withRev.drifted).toBe(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(regressedDoc());
    const first = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    const second = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same repo re-derive the same id.
    const grown = writeLedger([...regressedDoc(), entry({ attempt: 5, jobId: 'INC-ffffeeee0000-5' })]);
    const third = await incidentLedgerBacklogItems({ repo: REPO, ledgerPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded titles and sources before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const items = await incidentLedgerBacklogItems({
      repo: REPO, now: NOW,
      ledgerPath: writeLedger([
        entry({ attempt: 2, jobId: 'INC-aaaabbbbcccc-2', title: `leak ${token} in logs` }),
        entry({ attempt: 2, jobId: 'INC-ddddeeeeffff-2', source: `probe-${token}` }),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default ledger path under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    const dir = path.join(home, 'runs', 'incidents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'incidents.v1.json'), ledger(regressedDoc()));
    const items = await incidentLedgerBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^incident-ledger-regressed-/);
  });

  it('appends incident-ledger items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      const dir = path.join(home, 'runs', 'incidents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'incidents.v1.json'), ledger(regressedDoc()));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const ledgerItems = first.items.filter((i) => i.id.startsWith('incident-ledger-'));
      expect(ledgerItems).toHaveLength(1);
      expect(ledgerItems[0]!.id).toMatch(/^incident-ledger-regressed-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(ledgerItems)).toBe(ledgerItems.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('incident-ledger-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('incident-ledger-'))).toHaveLength(ledgerItems.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
