import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ciInputDigests } from '../src/core/fleet/ci-input-digests.js';
import { planCiResumeInputs } from '../src/core/fleet/ci-resume-inputs.js';
import { cmdFleetCiInputDigests } from '../src/cli/fleet-ci-input-digests.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const manifest = () => ({ version: 1, repo: 'owner/repo', jobs: [{ id: 'test', command: 'never-execute-this', os: 'linux', arch: 'x64', toolchain: 'node22', paths: ['covered'] }] });
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-seed-')); dirs.push(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  writeFileSync(join(cwd, 'covered'), 'first'); git('add', '.'); git('commit', '-qm', 'initial');
  return { cwd, git, commit: () => git('rev-parse', 'HEAD') };
}
describe('CI input digest seeds', () => {
  it('uses committed inputs and produces receipts usable only for matching successful results', async () => {
    const { cwd, git, commit } = repo(); const first = commit(); const m = manifest();
    const seed = await ciInputDigests({ manifest: m, head: first.slice(0, 10), cwd });
    expect(seed.head).toBe(first); expect(seed.kind).toBe('ci-input-digest-seeds');
    writeFileSync(join(cwd, 'unrelated'), 'uncommitted');
    expect(await ciInputDigests({ manifest: m, head: first, cwd })).toEqual(seed);
    const receipt = { job: 'test', run: 1, conclusion: 'success', inputsDigest: seed.jobs[0]!.inputDigest, headSha: first };
    const prior = { version: 1, repo: m.repo, receipts: [receipt] };
    const plan = (head: string, p: unknown = prior, man: unknown = m) => planCiResumeInputs({ manifest: man, prior: p, base: first, head, cwd });
    expect((await plan(first)).jobs[0]!.decision).toBe('reuse');
    expect((await plan(first, { ...prior, receipts: [{ ...receipt, conclusion: 'failure' }] })).jobs[0]!.decision).toBe('rerun');
    const changedTool = manifest(); changedTool.jobs[0]!.toolchain = 'node24';
    expect((await ciInputDigests({ manifest: changedTool, head: first, cwd })).jobs[0]!.inputDigest).not.toBe(seed.jobs[0]!.inputDigest);
    expect((await plan(first, prior, changedTool)).jobs[0]!.decision).toBe('rerun');
    writeFileSync(join(cwd, 'covered'), 'second'); git('add', 'covered'); git('commit', '-qm', 'content');
    const content = commit(); expect((await plan(content)).jobs[0]!.decision).toBe('rerun');
    expect((await ciInputDigests({ manifest: m, head: content, cwd })).jobs[0]!.inputDigest).not.toBe(seed.jobs[0]!.inputDigest);
    chmodSync(join(cwd, 'covered'), 0o755); git('add', 'covered'); git('commit', '-qm', 'mode');
    const mode = await ciInputDigests({ manifest: m, head: commit(), cwd });
    expect(mode.jobs[0]!.inputDigest).not.toBe((await ciInputDigests({ manifest: m, head: content, cwd })).jobs[0]!.inputDigest);
    git('rm', '-q', 'covered'); git('commit', '-qm', 'delete');
    expect((await ciInputDigests({ manifest: m, head: commit(), cwd })).jobs[0]!.inputDigest).not.toBe(mode.jobs[0]!.inputDigest);
  });
  it('rejects bad input and never invokes manifest commands', async () => {
    const { cwd, commit } = repo(); const file = join(cwd, 'manifest.json');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeFileSync(file, JSON.stringify(manifest()));
    expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', commit(), '--json'], { cwd })).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0])).jobs[0].inputDigest).toMatch(/^sha256:/);
    expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', 'bad revision'], { cwd })).toBe(2);
    expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', 'ffff'], { cwd })).toBe(2);
    expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', commit(), '--json', '--json'], { cwd })).toBe(2);
    writeFileSync(file, '{'); expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', commit()], { cwd })).toBe(2);
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1)); expect(await cmdFleetCiInputDigests(['--manifest', file, '--head', commit()], { cwd })).toBe(2);
    expect(await cmdFleetCiInputDigests(['--help'], { cwd })).toBe(0);
  });
});
