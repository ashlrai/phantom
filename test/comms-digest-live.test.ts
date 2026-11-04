import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectDigestFacts, planChangeDigest, runChangeDigest, type DigestSources, type DigestState } from '../src/core/comms/change-digest.js';
import { getFleetTruth } from '../src/core/fleet/fleet-truth.js';

const now = Date.parse('2026-11-04T06:00:00Z');
const since = now - 86_400_000;
const previous: DigestState = {
  v: 1, lastCheckAt: new Date(since).toISOString(), lastSentAt: new Date(since).toISOString(),
  lastActivityAt: '2026-10-09T00:00:00Z', reported: [], exhaustedSeats: [],
  idleNoticeFor: '2026-10-09T00:00:00Z',
};

it('counts exactly the mocked gh merged window and dispatch state, then stays silent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-live-'));
  try {
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue', 'admission.json'), JSON.stringify({ ts: new Date(now).toISOString(), running: 4 }));
    writeFileSync(join(root, 'queue', 'ready.tsv'), 'status\tpool\tid\nREADY\tcodex\ta\nREADY\tclaude\tb\nBLOCKED\tcodex\tc\nREADY\tPARKED-DEP.codex\td\nDONE\tclaude\te\n');
    const rows = Array.from({ length: 17 }, (_, i) => ({
      repository: { nameWithOwner: `ashlrai/repo-${i % 2}` }, number: i + 1,
      title: 'Merged work', closedAt: new Date(now - 60_000 - i * 1000).toISOString(),
    }));
    const sources: DigestSources = {
      ledger: async () => [{ kind: 'merge:landed', at: new Date(now - 1000).toISOString(), repo: 'ashlrai/stale', data: { prNumber: 999 } }],
      appliedProposals: () => [], proposalTitle: () => null, cloudTasks: () => [], capacity: () => null,
      memos: () => [], autonomy: () => ({ on: true, mode: 'autonomous' }),
      fleetTruth: (start, end) => getFleetTruth(start, {
        nowMs: end, fresh: true, githubOnly: true, runsDir: root,
        ledgerMerges: () => { throw new Error('must not consult ledger'); },
        gh: async (args) => {
          expect(args.slice(0, 2)).toEqual(['search', 'prs']);
          expect(args).toContain('--merged');
          expect(args[args.indexOf('--merged-at') + 1]).toBe(`${new Date(since).toISOString()}..${new Date(now).toISOString()}`);
          return JSON.stringify(rows);
        },
      }),
    };
    const facts = await collectDigestFacts(since, sources, now);
    expect(facts.events.filter((e) => e.kind === 'merge')).toHaveLength(rows.length);
    const plan = planChangeDigest(previous, facts, now);
    expect(plan.text).toContain('17 merged');
    expect(plan.text).toContain('Merged (17):');
    expect(plan.text).toContain('Window merges: 17 (ashlrai/repo-0: 9, ashlrai/repo-1: 8)');
    expect(plan.text).toContain('4 running, 2 ready, 2 blocked');
    expect(plan.text).toContain('Source: gh search prs');
    expect(plan.text).toContain(`as-of ${new Date(now).toISOString()}`);
    expect(plan.next.lastActivityAt).toBe(rows[0]!.closedAt);
    expect(planChangeDigest(plan.next, facts, now + 1000).text).toBeNull();
    const empty = await collectDigestFacts(since, { ...sources, fleetTruth: async () => ({
      windowStartMs: since, windowEndMs: now, merged: [], mergeCountState: 'ok', truncated: false,
      running: 0, queued: 0, blocked: 0,
    }) }, now);
    expect(planChangeDigest(previous, empty, now).text).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('queues new live activity after a stale watermark and does not queue it twice', async () => {
  const dir = join(homedir(), '.ashlr', 'comms');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'digest-state.json'), JSON.stringify(previous));
  const sources: DigestSources = {
    ledger: async () => [], appliedProposals: () => [], proposalTitle: () => null, cloudTasks: () => [],
    capacity: () => null, memos: () => [], autonomy: () => ({ on: true, mode: 'autonomous' }),
    fleetTruth: async () => ({
      windowStartMs: since, windowEndMs: now, mergeCountState: 'ok', truncated: false,
      running: 2, queued: 3, blocked: 1,
      merged: [{ repo: 'ashlrai/phantom', number: 10, title: 'Live merge',
        url: 'https://github.com/ashlrai/phantom/pull/10', mergedAtMs: now - 1000, source: 'gh' }],
    }),
  };
  const result = await runChangeDigest({ nowMs: now, sources });
  expect(result.posted).toBe(true);
  expect(result.requestId).toBeTruthy();
  expect(result.text).toContain('1 merged');
  const quiet = await runChangeDigest({ nowMs: now + 1000, sources });
  expect(quiet.posted).toBe(false);
  expect(quiet.requestId).toBeNull();
});
