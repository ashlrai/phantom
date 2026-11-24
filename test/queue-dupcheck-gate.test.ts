import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueDupcheck } from '../src/cli/queue-dupcheck.js';
import { dupcheckGoalText, type DupcheckSources } from '../src/core/queue/dupcheck.js';
import {
  DUPCHECK_GATE_SCHEMA, DUPCHECK_STATS_SCHEMA, dupcheckGate, readDupcheckStats, recordDupcheckGate, recordDupcheckOutcomes, summarizeDupcheck,
} from '../src/core/queue/dupcheck-gate.js';

const sources = (over: Partial<DupcheckSources> = {}): DupcheckSources => ({
  commands: [{ name: 'phm shipped [--since 7d] [--json]', text: 'What shipped.', ref: 'src/cli/help.ts', type: 'command' }],
  panes: [], fileExists: () => false, merged: [], gaps: [], ...over,
});
const task = (id: string, goal: string): string => `Task, verbatim:\n\n${id} (P1, pool=claude): ${goal} Acceptance: tests pass.\n`;
const gateOf = (goal: string, over: Partial<DupcheckSources> = {}, id = 'RQ-ONE') =>
  dupcheckGate(dupcheckGoalText(task(id, goal), sources(over), { jobId: id }));

describe('dupcheck gate', () => {
  it('skips with the evidence when this job id already merged', () => {
    const g = gateOf('Add phm shipped.', { merged: [{ jobId: 'RQ-ONE', pr: 12, title: 'Add shipped', mergedAt: new Date().toISOString() }] });
    expect(g).toMatchObject({ schema: DUPCHECK_GATE_SCHEMA, action: 'skip', confidence: 'high', reason: 'already_done', line: null });
    expect(g.evidence.some(e => e.type === 'merged' && e.ref === 'PR #12')).toBe(true);
  });

  it('skips when every named command and flag is there', () => {
    const g = gateOf('Give `phm shipped` a --since flag.');
    expect(g).toMatchObject({ action: 'skip', confidence: 'high', reason: 'already_done' });
    expect(g.evidence.map(e => e.ref)).toContain('src/cli/help.ts');
  });

  it('warns, still launches, and carries the evidence as one "Check this first" line', () => {
    const g = gateOf('Add `phm shipped` to the digest.');
    expect(g).toMatchObject({ action: 'warn', confidence: 'medium', reason: 'already_done' });
    expect(g.line).toMatch(/^Check this first: phm shipped \(src\/cli\/help\.ts\)/);
    expect(g.line).not.toContain('\n');
  });

  it('launches when the work is new, partial or unknown, and a bare file never skips', () => {
    expect(gateOf('Add `phm brandnew`.')).toMatchObject({ action: 'launch', confidence: 'none', reason: null, line: null });
    expect(gateOf('Give `phm shipped` a --site flag.')).toMatchObject({ action: 'launch', confidence: 'low' });
    expect(gateOf('Tidy things up.').action).toBe('launch');
    expect(gateOf('Edit src/cli/shipped.ts.', { fileExists: () => true }).action).toBe('launch');
  });
});

describe('dupcheck record and stats', () => {
  let runs = '';
  const setup = async (): Promise<string> => { runs = await mkdtemp(join(tmpdir(), 'dupgate-')); await mkdir(join(runs, 'metrics')); return runs; };
  const gate = (goal: string, id: string) => gateOf(goal, {}, id);
  afterEach(() => { vi.restoreAllMocks(); delete process.env.ASHLR_RUNS_DIR; });

  it('counts skips, launches, launches that ended already_done and false skips', async () => {
    const dir = await setup();
    await recordDupcheckGate(dir, gate('Give `phm shipped` a --since flag.', 'RQ-SKIPPED'));
    await recordDupcheckGate(dir, gate('Give `phm shipped` a --since flag.', 'RQ-WRONG'));
    await recordDupcheckGate(dir, gate('Add `phm shipped` to the digest.', 'RQ-WARNED'));
    await recordDupcheckGate(dir, gate('Add `phm brandnew`.', 'RQ-PLAIN'));
    await recordDupcheckGate(dir, gate('Add `phm brandnew`.', 'RQ-PLAIN'));
    await recordDupcheckGate(dir, gate('Add `phm brandnew`.', 'RQ-WRONG')); // the skipped row came back and launched
    const added = await recordDupcheckOutcomes(dir, [{ id: 'RQ-PLAIN', tag: 'already_done' }, { id: 'RQ-WARNED', tag: 'already_done' }, { id: 'RQ-SKIPPED', tag: 'already_done' }, { id: 'RQ-NOPE', tag: 'blocked' }]);
    expect(added).toBe(2); // the skipped job never launched; blocked is not already_done
    expect(await recordDupcheckOutcomes(dir, [{ id: 'RQ-PLAIN', tag: 'already_done' }])).toBe(0); // written once
    const s = await readDupcheckStats(dir);
    expect(s).toMatchObject({
      schema: DUPCHECK_STATS_SCHEMA, checked: 4, skips: 2, warns: 1, launches: 1,
      warned_ended_already_done: 1, launched_ended_already_done: 1, false_skips: 1, false_skip_jobs: ['RQ-WRONG'], skip_precision: 0.5,
    });
    expect(await readFile(join(dir, 'metrics', 'dupcheck.jsonl'), 'utf8')).not.toMatch(/Check this first/);
  });

  it('shows no record as empty stats and an unreadable record as unknown', async () => {
    const dir = await setup();
    expect(await readDupcheckStats(dir)).toMatchObject({ checked: 0, skip_precision: null });
    expect(summarizeDupcheck([]).false_skips).toBe(0);
    await mkdir(join(dir, 'metrics', 'dupcheck.jsonl'));
    expect(await readDupcheckStats(dir)).toBeNull();
  });

  it('never creates the metrics folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dupgate-'));
    expect(await recordDupcheckGate(dir, gate('Add `phm brandnew`.', 'RQ-X'))).toBe(false);
  });

  it('--gate --json prints the decision and records it; --stats --json prints the counts', async () => {
    const dir = await setup();
    process.env.ASHLR_RUNS_DIR = dir;
    const prompt = join(dir, 'RQ-CLI.md');
    await writeFile(prompt, task('RQ-CLI', 'Add `phm queue dupcheck-nothing-here`.'));
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
    expect(await cmdQueueDupcheck([prompt, '--gate', '--json'])).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: DUPCHECK_GATE_SCHEMA, job: 'RQ-CLI', action: 'launch' });
    expect(await cmdQueueDupcheck(['--stats', '--json'])).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ schema: DUPCHECK_STATS_SCHEMA, checked: 1, launches: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdQueueDupcheck(['--stats', prompt])).toBe(2);
    expect(await cmdQueueDupcheck(['--stats', '--gate'])).toBe(2);
  });
});
