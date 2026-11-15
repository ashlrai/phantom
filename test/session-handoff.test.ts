import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkpointSession, planSessionResume, planSessionFailover, readSessionHandoff, runSessionTurn } from '../src/core/agents/session-handoff.js';
import { scrubHandoffDraft, type HandoffDraft } from '../src/core/agents/session-handoff-schema.js';
import { acquireCoordination, listCoordination, settleCoordination } from '../src/core/agents/claim-store.js';
import { cmdCheckpoint } from '../src/cli/checkpoint.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'session-handoff-')); dirs.push(dir);
  const worktree = join(dir, 'repo'), runs = join(dir, 'runs'), claimsRoot = join(dir, 'claims');
  await mkdir(worktree); await mkdir(runs, { mode: 0o700 }); await mkdir(claimsRoot, { mode: 0o700 });
  const git = (...args: string[]) => promisify(execFile)('git', ['-C', worktree, ...args]);
  await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test');
  await writeFile(join(worktree, 'result'), ''); await git('add', '.');
  await git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'base\n\nEntire-Checkpoint: a3b2c4d5e6f7');
  const draft: HandoffDraft = { job: 'RQ-HANDOFF', attempt: 'attempt-1', repo: 'test/fixture', lane: 'codex-personal',
    model: 'model-a', minTier: 'work', needs: ['typescript'], goal: 'Produce five ordered results',
    plan: Array.from({ length: 5 }, (_, i) => ({ action: `Write result ${i + 1}`, state: 'pending' })),
    filesTouched: ['result'], decisions: ['Keep work in the original worktree'], evidence: ['result'],
    nextAction: 'Write result 1', contextDigest: 'Append each result exactly once.' };
  const options = { runs, worktree, claimsRoot, job: draft.job, attempt: draft.attempt, repo: draft.repo,
    lane: draft.lane, model: draft.model, tier: draft.minTier, owner: 'worker-a', capabilities: ['typescript'] };
  const save = (expectedRevision = 0, value = draft) => checkpointSession({ runs, worktree, draft: value,
    signal: { kind: 'checkpoint' }, expectedRevision });
  return { dir, runs, worktree, draft, options, save, git, packet: join(runs, 'handffs', `${draft.job}.jsonl`) };
}

it('continues at 80% on another lane/model without repeating completed work', async () => {
  const f = await fixture(); await f.save();
  const first = await runSessionTurn(f.options, async ({ checkpoint, assertLease }) => {
    for (let i = 0; i < 4; i++) {
      assertLease();
      await writeFile(join(f.worktree, 'result'), Array.from({ length: i + 1 }, (_, n) => String(n + 1)).join(','));
      f.draft.plan[i].state = 'done'; f.draft.nextAction = `Write result ${i + 2}`;
      await checkpoint(f.draft, i === 3 ? { kind: 'rate-limit', status: 429 } : { kind: 'checkpoint' });
    }
    throw new Error('Quota checkpoint must exit this turn');
  });
  expect(first.status).toBe('handoff');
  expect(readSessionHandoff(f.runs, f.draft.job).plan.filter(step => step.state === 'done')).toHaveLength(4);
  expect(listCoordination(f.options.claimsRoot).claims.filter(c => c.live)).toEqual([]);
  const candidate = { lane: 'claude', model: 'model-b', tier: 'work' as const, capabilities: ['typescript'], available: true, remainingFraction: 0.8 };
  expect(await planSessionFailover(f.options, [{ ...candidate, remainingFraction: null }])).toMatchObject({ status: 'pending' });
  const failover = await planSessionFailover({ ...f.options, owner: 'worker-b' }, [
    { ...candidate, lane: f.options.lane }, { ...candidate, remainingFraction: 0 }, { ...candidate, tier: 'fast' }, candidate,
  ]);
  expect(failover.status).toBe('ready');
  if (failover.status !== 'ready') throw new Error('Capable target should be selected');
  const second = await runSessionTurn(failover.resume, async ({ record, checkpoint }) => {
    expect(record.nextAction).toBe('Write result 5');
    expect(record.repoState.entireCheckpoint).toBe('a3b2c4d5e6f7');
    const remaining = record.plan.filter(step => step.state === 'pending'); expect(remaining).toHaveLength(1);
    await writeFile(join(f.worktree, 'result'), (await readFile(join(f.worktree, 'result'), 'utf8')) + ',5');
    // The second agent reconstructs everything from disk, with no first-agent draft state.
    const { schema: _schema, revision: _revision, at: _at, signal: _signal, repoState: _repoState, ...authored } = record;
    const draft = { ...authored, plan: record.plan.map(step => ({ ...step, state: 'done' as const })), nextAction: 'Report verification' };
    await checkpoint(draft, { kind: 'completed' });
    return readFile(join(f.worktree, 'result'), 'utf8');
  });
  expect(second).toEqual({ status: 'completed', value: '1,2,3,4,5' });
  expect(readSessionHandoff(f.runs, f.draft.job)).toMatchObject({ lane: 'claude', model: 'model-b', revision: 6 });
  expect((await stat(f.packet)).mode & 0o777).toBe(0o600);
  expect((await stat(join(f.runs, 'handffs'))).mode & 0o777).toBe(0o700);
  await expect(planSessionResume(f.options)).rejects.toThrow('completed');
});

it('checkpoints budget pressure before exit and rejects unknown or incapable targets', async () => {
  const f = await fixture(); await f.save();
  await expect(planSessionResume({ ...f.options, capabilities: [] })).rejects.toThrow('capabilities');
  await expect(planSessionResume({ ...f.options, tier: 'mid' })).rejects.toThrow('capabilities');
  await expect(planSessionResume({ ...f.options, attempt: 'another' })).rejects.toThrow('attempt');
  const result = await runSessionTurn(f.options, async ({ checkpoint }) => {
    await checkpoint(f.draft, { kind: 'budget', remainingFraction: 0.1, threshold: 0.1 });
    throw new Error('Must yield');
  });
  expect(result.status).toBe('handoff');
  expect(readSessionHandoff(f.runs, f.draft.job).signal.kind).toBe('budget');
});

it.each(['tracked', 'untracked', 'head'])('refuses %s drift, including edits with unchanged porcelain status', async kind => {
  const f = await fixture(); const file = join(f.worktree, kind === 'untracked' ? 'new-file' : 'result');
  await writeFile(file, 'first'); await f.save();
  const before = (await f.git('status', '--porcelain')).stdout;
  if (kind === 'head') await f.git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'moved');
  else { await writeFile(file, 'second'); expect((await f.git('status', '--porcelain')).stdout).toBe(before); }
  await expect(planSessionResume(f.options)).rejects.toThrow('Repository changed');
});

it('refuses concurrent ownership, releases partial acquisitions and retains no claim credentials in packets', async () => {
  const f = await fixture(); await f.save(); const now = Date.now();
  const held = acquireCoordination({ root: f.options.claimsRoot, origin: 'resource', key: 'repo:test/fixture', owner: 'other',
    leaseMs: 60000, leaseUntil: now + 60000, sourceId: 'other', now });
  expect(held.status).toBe('acquired');
  const work = vi.fn(); await expect(runSessionTurn(f.options, work)).rejects.toThrow('claim'); expect(work).not.toHaveBeenCalled();
  expect(listCoordination(f.options.claimsRoot).claims.filter(c => c.live).map(c => c.key)).toEqual(['repo:test/fixture']);
  if ('token' in held && held.token) {
    expect(await readFile(f.packet, 'utf8')).not.toContain(held.token);
    settleCoordination({ root: f.options.claimsRoot, key: 'repo:test/fixture', token: held.token, outcome: 'released' });
  }
});

it('scrubs all narrative fields before truncation and persists no raw credential', async () => {
  const f = await fixture(); const secret = 'sk-' + 'aB9'.repeat(18);
  const draft = { ...f.draft, goal: `Finish with ${secret}`, decisions: [`password=${secret}`],
    contextDigest: 'context '.repeat(1100) + secret, evidence: [`https://example.test/?token=${secret}`] };
  await f.save(0, draft);
  const text = await readFile(f.packet, 'utf8'); expect(text).not.toContain(secret);
  expect(readSessionHandoff(f.runs, f.draft.job).contextDigest.length).toBeLessThanOrEqual(8192);
  expect(scrubHandoffDraft({ ...f.draft, contextDigest: ' '.repeat(8180) + secret }).contextDigest).not.toContain('sk-');
});

it('fails closed on torn history, wrong revisions, symlinks and storage inside a repository', async () => {
  const f = await fixture(); await f.save(); const original = await readFile(f.packet, 'utf8');
  await expect(f.save()).rejects.toThrow('revision'); expect(await readFile(f.packet, 'utf8')).toBe(original);
  await writeFile(f.packet, original + '{');
  expect(() => readSessionHandoff(f.runs, f.draft.job)).toThrow('incomplete');
  await expect(f.save(1)).rejects.toThrow('incomplete');
  await rm(f.packet); await symlink(join(f.worktree, 'result'), f.packet);
  await expect(f.save(1)).rejects.toThrow(); expect(await readFile(join(f.worktree, 'result'), 'utf8')).toBe('');
  await expect(checkpointSession({ runs: f.worktree, worktree: f.worktree, draft: f.draft,
    signal: { kind: 'checkpoint' }, expectedRevision: 0 })).rejects.toThrow('outside repositories');
});

it('exposes save/show/plan through the existing checkpoint CLI with safe errors', async () => {
  const f = await fixture(); const request = join(f.runs, 'request.json');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  await writeFile(request, JSON.stringify({ draft: f.draft, signal: { kind: 'checkpoint' }, expectedRevision: 0 }));
  expect(await cmdCheckpoint(['handoff', 'save', request, f.runs, f.worktree, '--json'])).toBe(0);
  expect(await cmdCheckpoint(['handoff', 'show', f.runs, f.draft.job])).toBe(0);
  const { claimsRoot: _claimsRoot, ...plan } = f.options; await writeFile(request, JSON.stringify(plan));
  expect(await cmdCheckpoint(['handoff', 'plan', request])).toBe(0);
  expect(JSON.parse(out.mock.calls.at(-1)![0]).advisory).toBe(true);
  await writeFile(request, '{"password":"fixture-only-never-echo"');
  expect(await cmdCheckpoint(['handoff', 'plan', request])).toBe(2);
  expect(err.mock.calls.flat().join('')).not.toContain('fixture-only-never-echo');
});

it('refuses expired checkpoints and lost leases before publishing new progress', async () => {
  const f = await fixture(); await f.save(); const original = await readFile(f.packet, 'utf8');
  const old = JSON.parse(original); old.at = new Date(Date.now() - 25 * 3600000).toISOString();
  await writeFile(f.packet, JSON.stringify(old) + '\n');
  await expect(planSessionResume(f.options)).rejects.toThrow('expired');
  await writeFile(f.packet, original);
  await expect(runSessionTurn(f.options, async ({ checkpoint }) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    try { await checkpoint(f.draft, { kind: 'quota-exhausted' }); }
    finally { clock.mockRestore(); }
  })).rejects.toThrow('claim lost');
  expect(await readFile(f.packet, 'utf8')).toBe(original);
});

it('keeps the capability floor, completion state and record size strict', async () => {
  const f = await fixture(); await f.save();
  await expect(f.save(1, { ...f.draft, needs: [] })).rejects.toThrow('conflict');
  await expect(f.save(1, { ...f.draft, minTier: 'fast' })).rejects.toThrow('conflict');
  await expect(checkpointSession({ ...f.options, draft: f.draft, signal: { kind: 'completed' }, expectedRevision: 1 }))
    .rejects.toThrow('Incomplete plan');
  await expect(f.save(1, { ...f.draft, decisions: Array(32).fill('bounded words '.repeat(140)) })).rejects.toThrow('oversized');
  expect(readSessionHandoff(f.runs, f.draft.job).revision).toBe(1);
});
