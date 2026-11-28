import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESOLUTION_WITNESS_MIN_CORRUPT,
  RESOLUTION_WITNESS_MIN_DAYS,
  RESOLUTION_WITNESS_MIN_ROWS,
  RESOLUTION_WITNESS_TAIL_BYTES,
  foldResolutionWitnessRows,
  parseResolutionWitnessJournal,
  parseResolutionWitnessJournalEntry,
  resolutionWitnessBacklogItems,
  resolutionWitnessCells,
} from '../src/core/improve/resolution-witness-backlog.js';
import { resolutionWitnessDigest } from '../src/core/fleet/resolution-witness-ledger.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Fixed evaluation instant; fixture decidedAt stamps are canonical ISO-8601 UTC like the writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'resolution-witness-backlog-'));
  savedHome = process.env['HOME'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await rm(home, { recursive: true, force: true });
});

interface WitnessSpec {
  atMs?: number;
  scannerId?: string;
  scannerRevision?: number;
  repo?: string;
  itemId?: string;
  objective?: string;
  observerRunId?: string;
  resolutionKind?: string;
  decision?: string;
  schemaVersion?: number;
  postStateBaseDigest?: string;
  observationBaseDigest?: string;
  /** Override the recomputed digest (mismatch cases). */
  resolutionDigest?: string;
  extra?: Record<string, unknown>;
}

/** One row in the writer's ledger shape, with a resolutionDigest recomputed under the writer's own pure function. */
function witness(spec: WitnessSpec = {}): string {
  const repo = spec.repo ?? join(home, 'phantom');
  const fields = {
    schemaVersion: spec.schemaVersion ?? 1,
    decision: spec.decision ?? 'no-change-required',
    repo,
    scannerId: spec.scannerId ?? 'merge-verify-contract',
    scannerRevision: spec.scannerRevision ?? 3,
    itemId: spec.itemId ?? 'item-1',
    objectiveHash: sha(spec.objective ?? 'obj-1'),
    observerRunId: spec.observerRunId ?? 'observer-run-1',
    postStateBaseDigest: spec.postStateBaseDigest ?? sha('post'),
    observationBaseDigest: spec.observationBaseDigest ?? sha('obs'),
    resolutionKind: spec.resolutionKind ?? 'merge-contract-satisfied',
    decidedAt: iso(spec.atMs ?? NOW_MS),
    witnessAttestation: sha('attestation'),
  };
  const digest = spec.resolutionDigest ?? resolutionWitnessDigest({
    decision: fields.decision as 'no-change-required',
    repo,
    scannerId: fields.scannerId,
    scannerRevision: fields.scannerRevision,
    itemId: fields.itemId,
    objectiveHash: fields.objectiveHash,
    observerRunId: fields.observerRunId,
    postStateBaseDigest: fields.postStateBaseDigest,
    observationBaseDigest: fields.observationBaseDigest,
    resolutionKind: fields.resolutionKind as 'merge-contract-satisfied',
  });
  return J({ ...fields, resolutionDigest: digest, ...spec.extra });
}

/** Write ledger text to <home>/.ashlr/fleet/resolution-witnesses.jsonl and return its path. */
function writeLedger(lines: string[]): string {
  const dir = join(home, '.ashlr', 'fleet');
  const file = join(dir, 'resolution-witnesses.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Three witness rows for one scanner build across three UTC days and three distinct objectives — the recurring cell. */
function recurringWitnesses(scannerId = 'merge-verify-contract', revision = 3): string[] {
  return [
    witness({ atMs: NOW_MS - DAY, objective: 'obj-a', observerRunId: 'run-1', scannerId, scannerRevision: revision }),
    witness({ atMs: NOW_MS - 2 * DAY, objective: 'obj-b', observerRunId: 'run-2', scannerId, scannerRevision: revision }),
    witness({ atMs: NOW_MS - 3 * DAY, objective: 'obj-c', observerRunId: 'run-3', scannerId, scannerRevision: revision }),
  ];
}

describe('parseResolutionWitnessJournalEntry', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    const good = JSON.parse(witness()) as Record<string, unknown>;
    expect(parseResolutionWitnessJournalEntry(good)).not.toBeNull();
    // Extra fields are ignored for forward compatibility.
    expect(parseResolutionWitnessJournalEntry({ ...good, futureField: 1 })).not.toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, schemaVersion: 2 })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, decision: 'change-required' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, scannerId: 'Bad Scanner' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, scannerRevision: 0 })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, itemId: '' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, objectiveHash: 'xyz' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, resolutionKind: 'other-kind' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, decidedAt: 'not-a-date' })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, decidedAt: '2026-11-23 12:00:00' })).toBeNull();
    // The writer's safeRepo canonicalizes through resolve(): a relative
    // string still lands absolute, so it is on-contract — what fails is a
    // non-string or an over-bound path.
    expect(parseResolutionWitnessJournalEntry({ ...good, repo: 42 })).toBeNull();
    expect(parseResolutionWitnessJournalEntry({ ...good, repo: 'x'.repeat(2000) })).toBeNull();
    expect(parseResolutionWitnessJournalEntry('nope')).toBeNull();
    expect(parseResolutionWitnessJournalEntry(null)).toBeNull();
  });

  it('rejects rows whose resolutionDigest does not recompute', () => {
    // Flip one hex char of a valid digest — every semantic field still parses
    // but the writer's binding check must fail.
    const good = JSON.parse(witness()) as Record<string, unknown>;
    const digest = String(good['resolutionDigest']);
    const flipped = (digest.startsWith('a') ? 'b' : 'a') + digest.slice(1);
    expect(parseResolutionWitnessJournalEntry({ ...good, resolutionDigest: flipped })).toBeNull();
    // And a digest mismatch caused by editing a covered field.
    expect(parseResolutionWitnessJournalEntry({
      ...good,
      scannerRevision: 4,
    })).toBeNull();
  });

  it('reduces rows to basename repo names, never full paths', () => {
    const row = parseResolutionWitnessJournalEntry(JSON.parse(witness({ repo: join(home, 'some', 'checkout-name') })));
    expect(row).not.toBeNull();
    expect(row!.repoName).toBe('checkout-name');
    expect(JSON.stringify(row)).not.toContain(home);
  });
});

describe('parseResolutionWitnessJournal', () => {
  it('counts malformed lines and digest mismatches without guessing', () => {
    const parsed = parseResolutionWitnessJournal([
      'not json',
      witness(),
      J({ schemaVersion: 1 }),
      witness({ resolutionDigest: sha('forged') }),
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(3);
    expect(parsed.replayedRows).toBe(0);
  });

  it('dedupes same-digest replays — including replays at a different decidedAt', () => {
    const first = JSON.parse(witness({ atMs: NOW_MS - DAY, objective: 'obj-a' })) as Record<string, unknown>;
    // Same semantic fields, later observation time: the digest does not cover
    // decidedAt, so this is a replay the writer's reader would also collapse.
    const replay = { ...first, decidedAt: iso(NOW_MS - 2 * DAY) };
    const parsed = parseResolutionWitnessJournal([J(first), J(replay)].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.replayedRows).toBe(1);
    expect(parsed.invalidRows).toBe(0);
  });
});

describe('foldResolutionWitnessRows + resolutionWitnessCells', () => {
  it('classes witness cells by (scannerId, scannerRevision) and keeps outside rows as context', () => {
    const text = [
      ...recurringWitnesses(),
      witness({ atMs: NOW_MS - HOUR, objective: 'obj-d', scannerRevision: 4 }),
      witness({ atMs: NOW_MS - 30 * DAY, objective: 'obj-e' }), // outside window
      'not json',
    ].join('\n');
    const fold = foldResolutionWitnessRows(text, { nowMs: NOW_MS });
    expect(fold.rows).toBe(4);
    expect(fold.outsideWindow).toBe(1);
    expect(fold.invalidRows).toBe(1);
    expect(fold.cells.size).toBe(2);
    const cells = resolutionWitnessCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      scannerId: 'merge-verify-contract', scannerRevision: 3,
      rows: RESOLUTION_WITNESS_MIN_ROWS, objectives: 3, records: 4,
    });
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(RESOLUTION_WITNESS_MIN_DAYS);
    expect(cells[0]!.repos).toEqual(['phantom']);
  });

  it('emits a cell only at the row and day bars', () => {
    // 3 rows, 2 days → cell.
    const cell = resolutionWitnessCells(foldResolutionWitnessRows(recurringWitnesses().join('\n'), { nowMs: NOW_MS }));
    expect(cell).toHaveLength(1);
    // 3 rows all on one UTC day → below the day bar.
    const sameDay = [
      witness({ atMs: Date.parse('2026-11-20T01:00:00Z'), objective: 'o1' }),
      witness({ atMs: Date.parse('2026-11-20T05:00:00Z'), objective: 'o2' }),
      witness({ atMs: Date.parse('2026-11-20T09:00:00Z'), objective: 'o3' }),
    ].join('\n');
    expect(resolutionWitnessCells(foldResolutionWitnessRows(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);
    // 2 rows across 2 days → below MIN_ROWS.
    const two = [
      witness({ atMs: NOW_MS - DAY, objective: 'o1' }),
      witness({ atMs: NOW_MS - 2 * DAY, objective: 'o2' }),
    ].join('\n');
    expect(resolutionWitnessCells(foldResolutionWitnessRows(two, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('splits cells by scanner revision so a retune restarts the count', () => {
    const text = [
      ...recurringWitnesses('merge-verify-contract', 3),
      ...recurringWitnesses('merge-verify-contract', 4),
    ].join('\n');
    const cells = resolutionWitnessCells(foldResolutionWitnessRows(text, { nowMs: NOW_MS }));
    expect(cells.map((c) => c.scannerRevision).sort()).toEqual([3, 4]);
  });

  it('marks cells lowerBound when told the tail truncated', () => {
    const fold = foldResolutionWitnessRows(recurringWitnesses().join('\n'), { nowMs: NOW_MS });
    expect(resolutionWitnessCells(fold, true)[0]!.lowerBound).toBe(true);
    expect(resolutionWitnessCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('resolutionWitnessBacklogItems', () => {
  it('emits an item for the fleet repo only', async () => {
    const file = writeLedger(recurringWitnesses());
    expect(await resolutionWitnessBacklogItems({ repo: 'someone/else', ledgerPath: file, now: NOW })).toEqual([]);
    const items = await resolutionWitnessBacklogItems({ repo: 'AshlrAI/Phantom', ledgerPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom', area: 'resolution-witness-merge-verify-contract', priority: 3 });
    expect(items[0]!.id).toMatch(/^resolution-witness-merge-verify-contract-r3-/);
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('never emits repo paths, item ids or digests into prompts', async () => {
    const file = writeLedger(recurringWitnesses());
    const items = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(home);
    expect(items[0]!.prompt).not.toContain('observer-run-1');
    expect(items[0]!.prompt).not.toContain('item-1');
    expect(items[0]!.prompt).toContain('3 distinct objective(s)');
    expect(items[0]!.prompt).toContain("'merge-verify-contract'");
    expect(items[0]!.prompt).toContain('revision 3');
  });

  it('yields nothing for a missing or all-invalid ledger', async () => {
    expect(await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: join(home, 'nope.jsonl'), now: NOW })).toEqual([]);
    const file = writeLedger(['not json', '{"schemaVersion":1}']);
    expect(await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW })).toEqual([]);
  });

  it('emits the corrupt-lines item at the contract-failure bar', async () => {
    const corrupt = ['not json', '{"schemaVersion":1}', '{"decision":"no-change-required"}'];
    const file = writeLedger([...corrupt, ...recurringWitnesses()]);
    const items = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    const corruptItem = items.find((i) => i.area === 'resolution-witness-corrupt');
    expect(corruptItem).toBeDefined();
    expect(corruptItem!.prompt).toContain(`${RESOLUTION_WITNESS_MIN_CORRUPT} line(s)`);
    expect(validBacklogItem(corruptItem!)).not.toBeNull();
  });

  it('does not emit the corrupt item below the bar', async () => {
    const file = writeLedger(['not json', ...recurringWitnesses()]);
    const items = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(items.map((i) => i.area)).toEqual(['resolution-witness-merge-verify-contract']);
  });

  it('states a lower bound when the byte tail truncated the ledger', async () => {
    // Pad the ledger past the 1 MiB read bound with out-of-window rows,
    // then append the recurring cell inside the retained tail.
    const noise: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      noise.push(witness({ atMs: NOW_MS - 30 * DAY, objective: `old-${i}`, observerRunId: `run-old-${i}` }));
    }
    const file = writeLedger([...noise, ...recurringWitnesses()]);
    expect(statSync(file).size).toBeGreaterThan(RESOLUTION_WITNESS_TAIL_BYTES);
    const items = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    const cell = items.find((i) => i.area === 'resolution-witness-merge-verify-contract');
    expect(cell).toBeDefined();
    expect(cell!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(recurringWitnesses());
    const first = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    const second = await resolutionWitnessBacklogItems({ repo: REPO, ledgerPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default ledger path under the install home', async () => {
    writeLedger(recurringWitnesses());
    const items = await resolutionWitnessBacklogItems({ repo: REPO, homeDir: home, now: NOW });
    expect(items).toHaveLength(1);
  });

  it('appends resolution-witness items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      // discoverBacklog calls the feed with no path overrides, so the feed
      // resolves <home>/.ashlr/fleet/resolution-witnesses.jsonl — under
      // vitest the process-home fixture makes homedir() follow
      // process.env.HOME, so relocate HOME to this test's temp dir.
      process.env['HOME'] = home;
      const dir = join(home, '.ashlr', 'fleet');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'resolution-witnesses.jsonl'), recurringWitnesses().join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('resolution-witness-'));
      expect(landed.length).toBeGreaterThanOrEqual(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('resolution-witness-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('resolution-witness-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
