import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueAutofill } from '../src/cli/queue-autofill.js';
import type { BetsProposal } from '../src/core/fleet/bets-propose.js';
import { planAutofill, QUEUE_AUTOFILL_SCHEMA } from '../src/core/fleet/queue-autofill.js';
import { parseFollowUps, STEP_ZERO, SHIP_PARTIAL, type AutofillCandidate } from '../src/core/fleet/autofill-sources.js';
import { QueueStore } from '../src/core/queue/store.js';

const bet = (n: number): BetsProposal => ({
  rank: n, id: `RQ-BET${n}`, repo: 'phantom', lane: 'claude', source: 'todo', size: 100, userFacing: false, score: 100 - n, verdict: 'new',
  goal: `Fix the plain thing number ${n}.`, acceptance: `Acceptance: thing ${n} works.`, evidence: { path: 'src/a.ts', line: n, area: 'core' }, suggestedDelta: null,
});
const proposed = (count: number, droppedGoals: string[] = []) => ({ proposals: Array.from({ length: count }, (_, i) => bet(i + 1)), droppedGoals });
const base = { lane: 'claude', running: 1, target: 8, existing: [] as { id: string; scope: string }[] };

describe('queue autofill plan', () => {
  it('drafts the gap for a starved lane', () => {
    const r = planAutofill({ ...base, min: 5, queued: 2, proposed: proposed(10) });
    expect(r.schema).toBe(QUEUE_AUTOFILL_SCHEMA);
    expect(r).toMatchObject({ lane: 'claude', running: 1, target: 8, queued: 2, applied: false });
    expect(r.drafted.map(d => d.id)).toEqual(['RQ-BET1', 'RQ-BET2', 'RQ-BET3']);
    expect(r.drafted[0]).toMatchObject({ repo: 'phantom', tier: 'work', acceptance: 'Acceptance: thing 1 works.' });
    expect(r.drafted[0]!.why).toContain('src/a.ts:1');
  });

  it('says the lane is full and drafts none', () => {
    const r = planAutofill({ ...base, min: 3, queued: 3, proposed: proposed(4) });
    expect(r.drafted).toEqual([]);
    expect(r.summary).toBe('Lane is full.');
  });

  it('skips every draft that already shipped or is already queued, with reasons', () => {
    const existing = [{ id: 'RQ-BET1', scope: 'old' }, { id: 'RQ-OTHER', scope: 'Fix the plain thing number 2.' }];
    const r = planAutofill({ ...base, min: 5, queued: 0, existing, proposed: proposed(2, ['Add the shipped thing.']) });
    expect(r.drafted).toEqual([]);
    expect(r.skipped.map(s => s.reason)).toEqual([
      'Already shipped: the bets check found it in this checkout.', 'Already queued as RQ-BET1.', 'Already queued as RQ-OTHER.',
    ]);
    expect(r.summary).toBe('Lane needs 5 more but no new bets were found.');
  });

  it('keeps an unknown queue depth unknown and drafts nothing', () => {
    const r = planAutofill({ ...base, min: 5, queued: null, running: null, target: null, proposed: proposed(3) });
    expect(r).toMatchObject({ queued: null, running: null, target: null, drafted: [] });
    expect(r.summary).toContain('unknown');
  });
});

describe('phm queue autofill', () => {
  let dir = '';
  let root = '';
  // A tiny checkout of its own: three open roadmap items with words no command or doc uses.
  const fixtureRoot = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'autofill-root-'));
    mkdirSync(join(r, 'docs'));
    writeFileSync(join(r, 'package.json'), '{"name":"@ashlr/phantom"}');
    writeFileSync(join(r, 'docs', 'ROADMAP-FIXTURE.md'), '- [ ] quantum harmonizer for llama choirs\n- [ ] plasma kettle scheduler\n- [ ] cobalt walrus ledger\n');
    return r;
  };
  afterEach(() => { vi.restoreAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); if (root) rmSync(root, { recursive: true, force: true }); dir = ''; root = ''; });
  const run = async (args: string[], queued: number | null) => {
    root = root || fixtureRoot();
    dir = dir || mkdtempSync(join(tmpdir(), 'autofill-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdQueueAutofill([...args, '--dir', dir], { readLane: async () => ({ running: 1, target: 8, queued }), root });
    return { code, out: log.mock.calls.map(c => String(c[0])).join('\n') };
  };

  it('is a dry run by default and writes only with --apply', async () => {
    const dry = await run(['--lane', 'claude', '--min', '2', '--json'], 0);
    const report = JSON.parse(dry.out);
    expect(dry.code).toBe(0);
    expect(report).toMatchObject({ schema: QUEUE_AUTOFILL_SCHEMA, lane: 'claude', min: 2, queued: 0, applied: false });
    expect(report.drafted).toHaveLength(2);
    expect(report.drafted[0]).toMatchObject({ repo: 'phantom', tier: 'work' });
    expect((await new QueueStore(dir).read()).jobs).toHaveLength(0);

    const applied = JSON.parse((await run(['--lane', 'claude', '--min', '2', '--apply', '--json'], 0)).out);
    expect(applied.applied).toBe(true);
    const jobs = (await new QueueStore(dir).read()).jobs;
    expect(jobs.map(j => j.id)).toEqual(applied.drafted.map((d: { id: string }) => d.id));
    expect(jobs.every(j => j.status === 'READY' && j.pool === 'claude')).toBe(true);

    // Run again with the same counts: the written bets are skipped as queued, new ones fill the gap.
    const again = JSON.parse((await run(['--lane', 'claude', '--min', '2', '--json'], 0)).out);
    expect(again.drafted.map((d: { id: string }) => d.id)).not.toContain(jobs[0]!.id);
    expect(again.skipped.some((s: { reason: string }) => s.reason.startsWith('Already queued'))).toBe(true);
  });

  it('prints "Lane is full." for a full lane', async () => {
    const r = await run(['--lane', 'claude', '--min', '2'], 2);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Lane is full.');
  });

  it('rejects a missing lane', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdQueueAutofill([])).toBe(2);
  });
});

describe('autofill source order', () => {
  const pick = (id: string, source: AutofillCandidate['source'], family = 'own*'): AutofillCandidate =>
    ({ id, repo: 'phantom', goal: `Do the ${id} thing.`, acceptance: 'Acceptance: done.', why: 'Because.', source, family });
  const plan = (over: Partial<Parameters<typeof planAutofill>[0]> = {}) =>
    planAutofill({ ...base, min: 6, queued: 0, proposed: proposed(2), ...over });

  it('takes ideas, then follow-ups, then bets, and says where each came from', () => {
    const r = plan({ first: [pick('RQ-IDEA1', 'idea'), pick('RQ-FOLLOWUP-2', 'follow-up')] });
    expect(r.drafted.map(d => [d.id, d.source])).toEqual([['RQ-IDEA1', 'idea'], ['RQ-FOLLOWUP-2', 'follow-up'], ['RQ-BET1', 'bet'], ['RQ-BET2', 'bet']]);
  });

  it('skips a candidate whose family is stopped', () => {
    const r = plan({ first: [pick('RQ-IDEA1', 'idea', 'dead*'), pick('RQ-IDEA2', 'idea', 'live*')], stoppedFamilies: new Set(['dead*']) });
    expect(r.drafted.map(d => d.id)).toEqual(['RQ-IDEA2', 'RQ-BET1', 'RQ-BET2']);
    expect(r.skipped.map(s => s.reason)).toContain('Family dead* is stopped: most of its jobs end empty.');
  });

  it('skips an idea that is already shipped or queued', () => {
    const r = plan({ first: [pick('RQ-IDEA1', 'idea')], shippedIdeas: ['Fix the slow lane.'], existing: [{ id: 'RQ-IDEA1', scope: 'x' }] });
    expect(r.drafted.map(d => d.id)).toEqual(['RQ-BET1', 'RQ-BET2']);
    expect(r.skipped.map(s => s.reason)).toEqual(['Already queued or shipped: the Ideas list says so.', 'Already queued as RQ-IDEA1.']);
  });

  it('starts every prompt with the Step-0 line and the ship-partial rule', () => {
    const r = plan({ first: [pick('RQ-IDEA1', 'idea'), pick('RQ-FOLLOWUP-2', 'follow-up')] });
    expect(r.drafted).toHaveLength(4);
    for (const d of r.drafted) {
      expect(d.prompt.startsWith(`${STEP_ZERO} ${SHIP_PARTIAL} `)).toBe(true);
      expect(d.prompt.endsWith(d.goal)).toBe(true);
    }
  });

  it('does not draft a prompt again once it is queued with the Step-0 prefix', () => {
    const first = plan();
    const existing = first.drafted.map(d => ({ id: `RQ-OTHER-${d.id}`, scope: d.prompt }));
    const again = plan({ existing });
    expect(again.drafted).toEqual([]);
  });

  it('reads Not built and Gaps notes from a log, inline or as bullets', () => {
    const log = 'done\nNot built: the nightly retry for stuck lanes\nGaps:\n- show unknown disk as unknown\n- none\nGaps: n/a\n';
    expect(parseFollowUps(log, 'RQ-X1').map(f => f.text)).toEqual(['the nightly retry for stuck lanes', 'show unknown disk as unknown']);
  });

  it('writes the Step-0 prompt and the source through the CLI with the seams', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autofill-src-'));
    const root = mkdtempSync(join(tmpdir(), 'autofill-src-root-'));
    writeFileSync(join(root, 'package.json'), '{"name":"@ashlr/phantom"}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const idea = { id: 'empty-launches:alpha', signal: 'empty-launches', title: 'Alpha jobs end empty', evidence: {}, payoff: { score: 5, text: 'saves slots' }, task: 'Cut the alpha job family.', why: 'w', lane: 'claude', status: 'proposed' } as const;
      const shipped = { ...idea, id: 'empty-launches:beta', title: 'Beta jobs end empty', status: 'shipped' } as const;
      const code = await cmdQueueAutofill(['--lane', 'claude', '--min', '2', '--apply', '--json', '--dir', dir], {
        readLane: async () => ({ running: 0, target: 4, queued: 0 }), root,
        sources: { readIdeas: async () => [idea, shipped], readFollowUps: async () => [{ text: 'build the quiet retry path', fromJob: 'RQ-ZED1' }], readStopped: async () => new Set<string>() },
      });
      const report = JSON.parse(String(log.mock.calls[0]![0]));
      expect(code).toBe(0);
      expect(report.schema).toBe(QUEUE_AUTOFILL_SCHEMA);
      expect(report.drafted.map((d: { source: string }) => d.source)).toEqual(['idea', 'follow-up']);
      expect(report.skipped[0].reason).toContain('Already queued or shipped');
      const jobs = (await new QueueStore(dir).read()).jobs;
      expect(jobs.every(j => j.scope.startsWith(STEP_ZERO))).toBe(true);
    } finally { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
});
