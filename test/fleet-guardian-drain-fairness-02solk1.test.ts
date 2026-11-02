import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drainGuardianInfraRetries } from '../src/core/fleet/guardian-retry-drain.js';
import { selectNextGuardianInfraRetry } from '../src/core/fleet/guardian-retry-next.js';
import type { GuardianOptions } from '../src/core/fleet/guardian-verify-loop.js';

const input = (repo: string, digit: string) => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
const key = (i: ReturnType<typeof input>) => createHash('sha256').update(JSON.stringify([i.repo, i.cohortId, i.proposalId, i.baseBranch, i.baseHead, i.candidateHead, i.mergeCommit, null, null, null])).digest('hex');
const entry = (i: ReturnType<typeof input>, checkedAt: string) => ({ key: key(i), repo: i.repo, sha: i.mergeCommit, terminal: 'fail', checkedAt, reason: 'verification-infrastructure', failureCategory: 'infra', cleanup: 'removed' });

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-fairness-'));
  const manifest = join(dir, 'manifest.json'); const sourceState = join(dir, 'state.json'); const outputDir = join(dir, 'out');
  const a = input('/fake/a', 'a'); const b = input('/fake/b', 'b');
  const entries = [entry(a, '2020-01-01T00:00:00Z'), entry(b, '2021-01-01T00:00:00Z')];
  await mkdir(outputDir);
  await writeFile(manifest, JSON.stringify([a, b]));
  await writeFile(sourceState, JSON.stringify({ version: 1, entries }));
  return { dir, manifest, sourceState, outputDir, a, b, entries };
}

describe('guardian drain fairness', () => {
  for (const checkedAt of ['2019-01-01T00:00:00Z', '2021-01-01T00:00:00Z']) {
    it(`continues past a still-red retry with timestamp ${checkedAt}`, async () => {
      const f = await fixture();
      try {
        const original = await readFile(f.sourceState, 'utf8');
        const attempts: string[] = [];
        const verify = async (options: GuardianOptions) => {
          const state = JSON.parse(await readFile(options.state, 'utf8')) as { version: 1; entries: typeof f.entries };
          const missing = [f.a, f.b].find(i => !state.entries.some(e => e.key === key(i)))!;
          attempts.push(missing.repo);
          state.entries.push(entry(missing, missing.repo === f.a.repo ? checkedAt : '2021-01-01T00:00:00Z'));
          await writeFile(options.state, JSON.stringify(state));
          return { state: 'ran' as const, summary: { passes: 1, pass: 0, fail: 1, unknown: 0, cancelled: false, deadlineExceeded: false } };
        };
        const summary = await drainGuardianInfraRetries({ ...f, maxRetries: 5, timeoutMs: 60000, apply: true }, { verify });
        expect(attempts).toEqual(['/fake/a', '/fake/b']);
        expect(summary).toMatchObject({ termination: 'exhausted', attempts: 2, verified: 2 });
        expect(await readFile(f.sourceState, 'utf8')).toBe(original);
        const final = JSON.parse(await readFile(summary.latestOutput!, 'utf8')) as { entries: typeof f.entries };
        expect(final.entries.map(e => e.failureCategory)).toEqual(['infra', 'infra']);
      } finally { await rm(f.dir, { recursive: true, force: true }); }
    });
  }
  it('honors the retry bound and selects oldest without exclusions', async () => {
    const f = await fixture();
    try {
      expect(await selectNextGuardianInfraRetry({ ...f, outputState: join(f.outputDir, 'probe') })).toEqual({ repo: f.a.repo, sha: f.a.mergeCommit });
      const attempts: string[] = [];
      const summary = await drainGuardianInfraRetries({ ...f, maxRetries: 1, timeoutMs: 60000, apply: true }, { verify: async options => {
        const state = JSON.parse(await readFile(options.state, 'utf8')) as { entries: typeof f.entries };
        attempts.push(state.entries.some(e => e.repo === f.a.repo) ? f.b.repo : f.a.repo);
        state.entries.push(f.entries[0]!);
        await writeFile(options.state, JSON.stringify(state));
        return { state: 'ran', summary: { passes: 1, pass: 0, fail: 1, unknown: 0, cancelled: false, deadlineExceeded: false } };
      } });
      expect(attempts).toEqual([f.a.repo]);
      expect(summary.termination).toBe('max-retries');
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
  it('validates the complete state even when all identities are excluded', async () => {
    const f = await fixture();
    try {
      await writeFile(f.sourceState, JSON.stringify({ version: 1, entries: [...f.entries, { invalid: true }] }));
      await expect(selectNextGuardianInfraRetry({ ...f, outputState: join(f.outputDir, 'probe'), exclude: [f.a, f.b].map(i => ({ repo: i.repo, sha: i.mergeCommit })) })).rejects.toThrow();
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
});
