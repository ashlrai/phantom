import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { compactGuardianState } from '../src/core/fleet/guardian-state-compact.js';
import { cmdFleetGuardianCompact } from '../src/cli/fleet-guardian-compact.js';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (i: number | 'new'): DetachedPostMergeRunnerInput => ({ repo: `/fake/${i}`, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: (i === 'new' ? 'f'.repeat(40) : i.toString(16).padStart(40, '0')) });
const validEntry = (keyFill: string) => ({ key: keyFill.repeat(64), repo: '/fake/x', sha: 'b'.repeat(40), terminal: 'pass', checkedAt: '2026-11-01T00:00:00.000Z', reason: 'verified', failureCategory: null, cleanup: 'removed' });
const bytes = (path: string): Promise<Buffer> => readFile(path);

describe('guardian state compaction (RQ-PHX-GUARDIANCOMPACT02SOLU2)', () => {
  it('compacts a full 1000-entry state and permits new manifest verification without rerunning retained pass/fail keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-compact-'));
    const manifestA = join(dir, 'a.json'), state = join(dir, 'state.json'), out = join(dir, 'out.json');
    const entries = Array.from({ length: 1000 }, (_, i) => input(i));
    // Manifests are capped at 100 entries, so fill the 1000-entry state in batches.
    const terminals = new Map([[0, 'pass'], [1, 'fail'], [2, 'unknown']] as const);
    const fill = async (item: DetachedPostMergeRunnerInput): Promise<DetachedPostMergeRunnerResult> => result(terminals.get(Number(item.repo.slice(6))) ?? 'pass');
    for (let batch = 0; batch < 10; batch++) {
      await writeFile(manifestA, JSON.stringify(entries.slice(batch * 100, batch * 100 + 100)));
      await runGuardianVerifyLoop({ manifest: manifestA, state, maxPasses: 1, intervalMs: 1, run: fill });
    }
    const source = JSON.parse(await readFile(state, 'utf8')) as { entries: { key: string; repo: string; sha: string }[] };
    expect(source.entries).toHaveLength(1000);

    const active = [entries[0]!, entries[1]!, entries[2]!];
    const added = input('new');
    const manifestB = join(dir, 'b.json');
    // New key first: the capacity proof below must throw before unknown is retried.
    await writeFile(manifestB, JSON.stringify([added, ...active]));
    // A full state cannot admit the new key until compacted.
    await expect(runGuardianVerifyLoop({ manifest: manifestB, state, maxPasses: 1, intervalMs: 1, run: async () => result('pass') })).rejects.toThrow('state capacity exceeded');

    expect(await compactGuardianState({ manifest: manifestB, sourceState: state, outputState: out })).toEqual({ before: 1000, retained: 3, removed: 997 });
    expect(await stat(out).then(s => s.mode & 0o777)).toBe(0o600);
    const compacted = JSON.parse(await readFile(out, 'utf8')) as { version: number; entries: { key: string; repo: string; sha: string }[] };
    expect(compacted.version).toBe(1);
    // Retained pass/fail/unknown rows are preserved unchanged, in source order.
    expect(compacted.entries).toEqual(active.map(a => source.entries.find(e => e.repo === a.repo && e.sha === a.mergeCommit)));

    const seen: string[] = [];
    const summary = await runGuardianVerifyLoop({ manifest: manifestB, state: out, maxPasses: 1, intervalMs: 1, run: async item => { seen.push(item.mergeCommit); return result('pass'); } });
    expect(summary).toMatchObject({ pass: 3, fail: 1, unknown: 0, cancelled: false });
    // unknown is retried and the new key runs; retained pass/fail keys are not rerun.
    expect(seen).toEqual([added.mergeCommit, entries[2]!.mergeCommit]);
  }, 30_000);

  it('rejects malformed, duplicate and conflicting manifests without touching inputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-compact-bad-'));
    const manifest = join(dir, 'm.json'), state = join(dir, 's.json'), out = join(dir, 'o.json');
    await writeFile(state, JSON.stringify({ version: 1, entries: [] }));
    const before = await bytes(state);
    for (const bad of [JSON.stringify('x'), '[]', JSON.stringify(Array.from({ length: 101 }, (_, i) => input(i))), JSON.stringify([{ ...input(0), extra: 1 }]), JSON.stringify([{ ...input(0), mergeCommit: 'nothex' }]), JSON.stringify([input(0), input(0)]), JSON.stringify([input(0), { ...input(0), proposalId: 'other' }]), '{}']) {
      await writeFile(manifest, bad);
      await expect(compactGuardianState({ manifest, sourceState: state, outputState: out })).rejects.toThrow();
    }
    await writeFile(manifest, JSON.stringify([input(0)]) + ' '.repeat(1_048_577));
    await expect(compactGuardianState({ manifest, sourceState: state, outputState: out })).rejects.toThrow('input too large');
    expect(await bytes(state)).toEqual(before);
  });

  it('rejects missing and malformed state, never emptying it, and leaves source intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-compact-badstate-'));
    const manifest = join(dir, 'm.json'), state = join(dir, 's.json'), out = join(dir, 'o.json');
    await writeFile(manifest, JSON.stringify([input(0)]));
    await expect(compactGuardianState({ manifest, sourceState: join(dir, 'absent.json'), outputState: out })).rejects.toThrow();
    for (const bad of ['{}', JSON.stringify({ version: 1, entries: [validEntry('a'), validEntry('a')] }), JSON.stringify({ version: 1, entries: [{ ...validEntry('a'), terminal: 'bogus' }] }), JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ ...validEntry('a'), stray: 1 }] })]) {
      await writeFile(state, bad);
      await expect(compactGuardianState({ manifest, sourceState: state, outputState: out })).rejects.toThrow();
    }
    const padded = JSON.stringify({ version: 1, entries: [] });
    await writeFile(state, padded + ' '.repeat(8_388_609 - padded.length));
    await expect(compactGuardianState({ manifest, sourceState: state, outputState: out })).rejects.toThrow('input too large');
    await writeFile(state, padded); // a valid state with no manifest-matching entries removes all
    expect(await compactGuardianState({ manifest, sourceState: state, outputState: out })).toEqual({ before: 0, retained: 0, removed: 0 });
    expect(await readFile(out, 'utf8')).toBe(padded);
  });

  it('rejects relative paths, path aliases and existing output without mutating source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guardian-compact-alias-'));
    await mkdir(join(dir, 'sub'));
    const manifest = join(dir, 'm.json'), state = join(dir, 's.json'), out = join(dir, 'o.json');
    await writeFile(manifest, JSON.stringify([input(0)]));
    await writeFile(state, JSON.stringify({ version: 1, entries: [] }));
    const before = await bytes(state);
    const canonicalState = await realpath(state);
    await expect(compactGuardianState({ manifest, sourceState: 'relative/s.json', outputState: out })).rejects.toThrow('absolute');
    // Aliases (symlink prefix and '..') of the same file are not distinct.
    await expect(compactGuardianState({ manifest, sourceState: state, outputState: canonicalState })).rejects.toThrow('distinct');
    await expect(compactGuardianState({ manifest, sourceState: join(dir, 'sub', '..', 's.json'), outputState: canonicalState })).rejects.toThrow('distinct');
    await expect(compactGuardianState({ manifest, sourceState: state, outputState: manifest })).rejects.toThrow('distinct');
    await writeFile(out, 'occupied');
    await expect(compactGuardianState({ manifest, sourceState: state, outputState: out })).rejects.toThrow('output already exists');
    expect(await bytes(state)).toEqual(before);
    expect(await readFile(out, 'utf8')).toBe('occupied');
  });

  it('CLI parses flags, prints bounded counts plus next-action, and maps failures to exit codes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const counts = { before: 5, retained: 2, removed: 3 };
      const code = await cmdFleetGuardianCompact(['--manifest', '/m', '--source-state', '/s', '--output-state', '/o', '--json'], async () => counts);
      expect(code).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ ...counts, nextAction: 'fleet guardian-verify --state <output-state>' });
      expect(await cmdFleetGuardianCompact(['--manifest', '/m', '--source-state', '/s'], async () => counts)).toBe(2);
      expect(await cmdFleetGuardianCompact(['--bogus', '/m'], async () => counts)).toBe(2);
      expect(await cmdFleetGuardianCompact(['--manifest', '/m', '--source-state', '/s', '--output-state', '/o'], async () => { throw new Error('state capacity exceeded'); })).toBe(1);
      expect(err.mock.calls.map(c => String(c[0])).join('')).not.toContain('capacity');
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});
