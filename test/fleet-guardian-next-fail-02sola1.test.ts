import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianRetry } from '../src/cli/fleet-guardian-retry.js';
import { prepareGuardianRetryState } from '../src/core/fleet/guardian-retry-state.js';

const input = (repo: string, proposalId = 'p') => ({ repo, cohortId: 'c', proposalId, baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: 'a'.repeat(40) });
const key = (i: ReturnType<typeof input>) => createHash('sha256').update(JSON.stringify([i.repo, i.cohortId, i.proposalId, i.baseBranch, i.baseHead, i.candidateHead, i.mergeCommit, null, null, null])).digest('hex');
const entry = (i: ReturnType<typeof input>, checkedAt: string, extra: object = {}) => ({ key: key(i), repo: i.repo, sha: i.mergeCommit, terminal: 'fail', checkedAt, reason: 'verification-infrastructure', failureCategory: 'infra', cleanup: 'removed', ...extra });

async function fixture(inputs: ReturnType<typeof input>[], entries: ReturnType<typeof entry>[]) {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-next-'));
  const manifest = join(dir, 'manifest.json'); const source = join(dir, 'source.json'); const output = join(dir, 'output.json');
  await writeFile(manifest, JSON.stringify(inputs));
  await writeFile(source, JSON.stringify({ version: 1, entries }));
  return { dir, manifest, source, output, args: ['--manifest', manifest, '--source-state', source, '--output-state', output, '--next-infra', '--json'] };
}

describe('guardian retry next infrastructure failure', () => {
  it('selects the oldest exact identity, ignoring same SHA and ineligible failures, and propagates verifier status', async () => {
    const a = input('/fake/a'); const b = input('/fake/b'); const c = input('/fake/c'); const wrong = input('/fake/b', 'other');
    const f = await fixture([a, b, c], [entry(wrong, '2020-01-01'), entry(a, '2021-01-01', { failureCategory: 'code' }), entry(c, '2024-01-01'), entry(b, '2022-01-01', { cleanup: 'not-created' })]);
    const original = await readFile(f.source, 'utf8');
    const verify = vi.fn(async () => 4);
    try {
      expect(await cmdFleetGuardianRetry([...f.args, '--verify', '--timeout-ms', '1234'], prepareGuardianRetryState, verify)).toBe(4);
      expect(verify).toHaveBeenCalledOnce();
      expect(verify.mock.calls[0]?.[0]).toContain('1234');
      expect(await readFile(f.source, 'utf8')).toBe(original);
      const state = JSON.parse(await readFile(f.output, 'utf8'));
      expect(state.entries.map((e: { key: string }) => e.key)).toEqual([key(wrong), key(a), key(c)]);
    } finally { await rm(f.dir, { recursive: true, force: true }); }
  });
  it('breaks timestamp ties by key and refuses to overwrite output', async () => {
    const a = input('/fake/a'); const b = input('/fake/b');
    const f = await fixture([a, b], [entry(a, '2022-01-01'), entry(b, '2022-01-01')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetGuardianRetry(f.args)).toBe(0);
      const state = JSON.parse(await readFile(f.output, 'utf8'));
      expect(state.entries[0].key).toBe([key(a), key(b)].sort()[1]);
      expect(await cmdFleetGuardianRetry(f.args)).toBe(3);
    } finally { log.mockRestore(); await rm(f.dir, { recursive: true, force: true }); }
  });
  it('reports no work without writing or invoking the verifier', async () => {
    const a = input('/fake/a'); const b = input('/fake/b');
    const f = await fixture([a], [entry(a, '2020-01-01', { terminal: 'unknown' }), entry(b, '2019-01-01')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const verify = vi.fn(async () => 0);
    try {
      expect(await cmdFleetGuardianRetry([...f.args, '--verify'], prepareGuardianRetryState, verify)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ status: 'no-work' });
      expect(verify).not.toHaveBeenCalled(); expect(existsSync(f.output)).toBe(false);
    } finally { log.mockRestore(); await rm(f.dir, { recursive: true, force: true }); }
  });
  it('rejects invalid, oversized and incompatible input before writing', async () => {
    const a = input('/fake/a'); const f = await fixture([a], [entry(a, '2020-01-01')]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleetGuardianRetry([...f.args, '--repo', a.repo])).toBe(2);
      expect(await cmdFleetGuardianRetry([...f.args, '--sha', a.mergeCommit])).toBe(2);
      await writeFile(f.source, '{'); expect(await cmdFleetGuardianRetry(f.args)).toBe(3);
      await writeFile(f.source, ' '.repeat(1_048_577)); expect(await cmdFleetGuardianRetry(f.args)).toBe(3);
      await writeFile(f.source, JSON.stringify({ version: 1, entries: [] }));
      await writeFile(f.manifest, '{'); expect(await cmdFleetGuardianRetry(f.args)).toBe(3);
      await writeFile(f.manifest, ' '.repeat(1_048_577)); expect(await cmdFleetGuardianRetry(f.args)).toBe(3);
      expect(existsSync(f.output)).toBe(false);
    } finally { err.mockRestore(); await rm(f.dir, { recursive: true, force: true }); }
  });
});
