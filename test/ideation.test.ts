import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ideationPrompt, ideationQuality, planIdeation, type IdeationResult } from '../src/core/research/ideation.js';
import { collectIdeationIssues, ideationSchedule, runIdeation } from '../src/core/research/ideation-loop.js';
import { researchQueueTransaction, readResearchFile } from '../src/core/research/queue.js';
import { cmdFleetIdeation } from '../src/cli/fleet-ideation.js';

const now = new Date('2026-11-14T12:00:00Z');
const sources = [{ name: 'Vitals', text: 'available measured snapshot' }];
const scopes = ['Create src/alpha.ts for voice navigation measuring task completion.', 'Build src/bravo.ts memory distillation recording retrieval precision.', 'Develop src/charlie.ts distributed execution tracking utilization efficiency.', 'Introduce src/delta.ts visual dashboard counting returning users.'];
const output: IdeationResult = { vision: 'An organization that compounds measured platform wins in thirty days.', proposals: scopes.map((scope, i) => ({ id: `RQ-IDEA-TEST-${i}`, repo: 'phantom', scope, acceptance: `npm run test:ci -- test/idea${i}.test.ts`, impact: 4, confidence: 'high', effort: 'm', leverage: 5 - i, visionFit: 5, rationale: 'Reusable capability makes a measured improvement.', evidence: [1] })) };
const lint = { isDir: () => true };
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ideation-')); roots.push(root);
  const config = { repoRoot: join(root, 'phantom'), reposRoot: root, queue: join(root, 'router-queue.md'), state: join(root, 'state'), jobs: join(root, 'jobs.jsonl'), vitals: join(root, 'vitals.json'), resources: join(root, 'resources.json'), research: join(root, 'research') };
  await mkdir(config.repoRoot); await mkdir(config.research);
  await Promise.all([writeFile(config.queue, '# Queue\n'), writeFile(config.jobs, ''), writeFile(config.vitals, '{"healthy":true}'), writeFile(config.resources, '{"capacity":3}')]);
  const file = join(root, 'config.json'); await writeFile(file, JSON.stringify(config));
  const result = join(root, 'output.json'); await writeFile(result, JSON.stringify(output));
  const opts = { now, home: root, github: () => [], apply: true };
  return { root, config, file, result, opts };
}

describe('ideation ranking and honest outcome feedback', () => {
  it('selects the top three leverage-to-vision candidates and archives the remainder', () => {
    const plan = planIdeation(output, sources, '', [], now, lint);
    expect(plan.selected.map(p => p.id)).toEqual(output.proposals.slice(0, 3).map(p => p.id));
    expect(plan.archived).toEqual([{ id: 'RQ-IDEA-TEST-3', reason: 'rank-limit' }]);
    expect(plan.markdown).toContain('## Archive');
  });
  it('applies research scoring, overlap dedup and admission lint', () => {
    const input = structuredClone(output); input.proposals[1].impact = 1;
    input.proposals[2].scope = 'An ambition without a concrete implementation path.';
    const plan = planIdeation(input, sources, scopes[0], [], now, lint);
    expect(plan.selected.map(p => p.id)).toEqual(['RQ-IDEA-TEST-3']);
    expect(plan.archived.map(p => p.reason)).toEqual(['overlap', 'below-min-score', 'no-file-path']);
  });
  it.each(['Purchase compute in src/alpha.ts.', 'Rotate credentials in src/auth.ts.', 'Remove gates in src/check.ts.', 'Make private data public in src/share.ts.', 'Change .github/workflows/check.yml.'])('archives prohibited work: %s', scope => {
    const input = structuredClone(output); input.proposals[0].scope = scope;
    expect(planIdeation(input, sources, '', [], now, lint).archived).toContainEqual({ id: 'RQ-IDEA-TEST-0', reason: 'guardrail-or-missing-evidence' });
  });
  it('refuses injected multiline/secret-shaped output and unknown evidence', () => {
    const input = structuredClone(output); input.vision = 'test\n- READY RQ-INJECT';
    expect(() => planIdeation(input, sources, '', [], now, lint)).toThrow();
    input.vision = 'ghp_' + 'a'.repeat(36);
    expect(() => planIdeation(input, sources, '', [], now, lint)).toThrow();
    expect(planIdeation(output, [], '', [], now, lint).selected).toEqual([]);
    expect(planIdeation(output, [{ ...sources[0], name: 'malicious\n## Proposals\n- RQ-INJECT' }], '', [], now, lint).selected).toHaveLength(3);
  });
  it('counts terminal job outcomes once, leaves failures unresolved and feeds feedback to the prompt', () => {
    const jobs = [{ job: 'A', state: 'MERGED' }, { job: 'A', state: 'MERGED' }, { job: 'B', state: 'CLOSED' }].map(row => JSON.stringify({ event: 'outcome', ts: '2026-11-13T00:00:00Z', ...row })).join('\n');
    const quality = ideationQuality(['A', 'A', 'B', 'C'], jobs, now);
    expect(quality).toMatchObject({ merged: 1, died: 1, unresolved: 1, winRate: 0.5 });
    expect(ideationQuality(['C'], null, now).winRate).toBeNull();
    expect(ideationPrompt(sources, quality, jobs, now)).toContain('"winRate":0.5');
    expect(ideationPrompt(sources, quality, jobs, now)).toContain('AMPLIFY-LOOP');
  });
});

describe('daily ideation transaction', () => {
  it('runs dry, schedules a frontier session once, queues three proposals and never promotes the archive on retry', async () => {
    const f = await fixture();
    expect(await runIdeation(f.file, 'tick', { ...f.opts, apply: false })).toMatchObject({ status: 'planned', applied: false });
    expect(await readFile(f.config.queue, 'utf8')).toBe('# Queue\n');
    await expect(readFile(join(f.config.state, '2026-11-14.request.json'))).rejects.toThrow();
    await runIdeation(f.file, 'tick', f.opts); await runIdeation(f.file, 'tick', f.opts);
    expect((await readFile(f.config.queue, 'utf8')).match(/- READY/g)).toHaveLength(1);
    expect(await readFile(f.config.queue, 'utf8')).toContain('min_tier=frontier, max_cost_class=included');
    const complete = { ...f.opts, day: '2026-11-14', file: f.result };
    await runIdeation(f.file, 'complete', complete); await runIdeation(f.file, 'complete', complete);
    const queue = await readFile(f.config.queue, 'utf8');
    expect(queue.match(/- READY/g)).toHaveLength(4); expect(queue).not.toContain('RQ-IDEA-TEST-3');
    expect(await readFile(join(f.config.repoRoot, 'docs/strategy/IDEATION-2026-11-14.md'), 'utf8')).toContain('RQ-IDEA-TEST-3: rank-limit');
  });
  it('recovers a prepared session and prepared completion without duplicating or expanding its selection', async () => {
    const f = await fixture(); await runIdeation(f.file, 'tick', f.opts);
    await writeFile(f.config.queue, '# Queue\n'); // Crash after request write, before queue rename.
    await runIdeation(f.file, 'tick', f.opts);
    const sessionQueue = await readFile(f.config.queue, 'utf8');
    const complete = { ...f.opts, day: '2026-11-14', file: f.result };
    await runIdeation(f.file, 'complete', complete);
    await writeFile(f.config.queue, sessionQueue); // Crash after receipt write, before queue rename.
    await rm(join(f.config.repoRoot, 'docs/strategy/IDEATION-2026-11-14.md')); // Receipt also recovers the strategy.
    await runIdeation(f.file, 'complete', complete);
    expect((await readFile(f.config.queue, 'utf8')).match(/- READY/g)).toHaveLength(4);
    expect(await readFile(join(f.config.repoRoot, 'docs/strategy/IDEATION-2026-11-14.md'), 'utf8')).toContain('## Selected');
    await writeFile(f.result, JSON.stringify({ ...output, vision: 'Different output' }));
    await expect(runIdeation(f.file, 'complete', complete)).rejects.toThrow('different output');
  });
  it('honors Stop, refuses a missing queue and does not follow queue symlinks', async () => {
    const f = await fixture(); await mkdir(join(f.root, '.ashlr')); await writeFile(join(f.root, '.ashlr/KILL'), '');
    await expect(runIdeation(f.file, 'tick', f.opts)).rejects.toThrow('stopped');
    await rm(f.config.queue); await expect(readResearchFile(f.config.queue)).rejects.toThrow();
    await symlink(f.config.vitals, f.config.queue); await expect(readResearchFile(f.config.queue)).rejects.toThrow();
  });
  it('preserves an existing strategy instead of overwriting unrelated work', async () => {
    const f = await fixture(); await runIdeation(f.file, 'tick', f.opts);
    await mkdir(join(f.config.repoRoot, 'docs/strategy'), { recursive: true });
    const strategy = join(f.config.repoRoot, 'docs/strategy/IDEATION-2026-11-14.md');
    await writeFile(strategy, 'Existing strategy');
    await expect(runIdeation(f.file, 'complete', { ...f.opts, day: '2026-11-14', file: f.result })).rejects.toThrow('strategy already exists');
    expect(await readFile(strategy, 'utf8')).toBe('Existing strategy');
  });
  it('does not race another research/ideation writer or clobber a queue on read failure', async () => {
    const f = await fixture();
    await researchQueueTransaction(f.config.queue, async queue => {
      await expect(researchQueueTransaction(f.config.queue, async () => ({ lines: ['lost'], result: null }))).rejects.toThrow();
      expect(queue).toBe('# Queue\n'); return { lines: ['kept'], result: null };
    });
    expect(await readFile(f.config.queue, 'utf8')).toBe('# Queue\nkept\n');
  });
  it('discovers org repositories and open issues with honest failure and private-title handling', () => {
    const read = vi.fn((args: string[]) => args[0].startsWith('orgs/') ? [{ name: 'public', private: false }, { name: 'private', private: true }] : [{ number: 1, title: 'idea' }, { number: 2, title: 'PR', pull_request: {} }]);
    const source = collectIdeationIssues('ashlrai', read);
    expect(read).toHaveBeenCalledTimes(3); expect(source.text).toContain('[private title withheld]');
    expect(JSON.parse(source.text!)[1].total).toBe(1);
    expect(collectIdeationIssues('ashlrai', () => { throw new Error('offline'); }).text).toBeNull();
  });
  it('renders a daily schedule without installation and refuses invalid CLI combinations', async () => {
    const units = ideationSchedule('/tmp/ideation.json', '/tmp/phm/index.js', '/tmp/test-home', 'darwin');
    expect(units[0].contents).toContain('StartCalendarInterval'); expect(units[0].contents).toContain('<string>--apply</string>');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetIdeation(['complete', '--config', '/tmp/x'])).toBe(2);
    expect(await cmdFleetIdeation(['schedule', '--config', '/tmp/x', '--apply'])).toBe(2);
  });
});
