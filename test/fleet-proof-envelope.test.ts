import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetProof } from '../src/cli/fleet-proof.js';
import { capturePublishProof } from '../src/core/fleet/proof-capture.js';
import { PROOF_MAX_BYTES, proofEnvelopeSchema, proofHash, readProofFile, serializeProofEnvelope, verifyProofResult, type ProofEnvelope } from '../src/core/fleet/proof-envelope.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-proof-'))); roots.push(root);
  const repo = join(root, 'repo'), out = join(root, 'results'); mkdirSync(repo); mkdirSync(out);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); writeFileSync(join(repo, 'source.txt'), 'before\n'); git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD'); writeFileSync(join(repo, 'source.txt'), 'after\nextra\n'); git('add', '.');
  const file = join(out, 'J.proof.json'), result = join(out, 'J.publish'), log = join(root, 'runner.log');
  writeFileSync(log, '2 tests passed\n');
  const captured = capturePublishProof({ repo, gitDir: join(repo, '.git'), layout: 'repo', base, output: file, test: { cmd: 'npm test', exitCode: 0, log } });
  writeFileSync(result, `PROOF ${captured.file} sha256:${captured.sha256}\nRESULT PR https://github.com/example/repo/pull/1\n`);
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as ProofEnvelope;
  const save = () => { const text = serializeProofEnvelope(envelope); writeFileSync(file, text); writeFileSync(result, `PROOF J.proof.json sha256:${proofHash(text)}\n`); };
  return { root, repo, out, base, file, result, log, envelope, save };
}

describe('fleet.proof.v1', () => {
  it('captures staged artifacts and measured stats, never unstaged changes or prose claims', () => {
    const f = fixture();
    expect(f.envelope.diffStats).toEqual({ files: 1, added: 2, removed: 1 });
    expect(f.envelope.claims).toEqual([]);
    writeFileSync(join(f.repo, 'source.txt'), 'unstaged\n');
    expect(readFileSync(join(f.out, 'J.proof.json.diff'), 'utf8')).toContain('+extra');
    expect(f.envelope.verification[0]).toMatchObject({ cmd: 'npm test', exitCode: 0 });
    expect(verifyProofResult(f.result).flags).toEqual(['Risk tier requires reviewer classification']);
    f.envelope.riskTier = 'low'; f.save();
    expect(verifyProofResult(f.result).ok).toBe(true);
  });
  it('validates closed versions, enums, unknown keys, numeric and byte bounds', () => {
    const f = fixture();
    for (const changed of [{ schema: 'fleet.proof.v2' }, { unexpected: true }, { riskTier: 'safe' },
      { diffStats: { files: -1, added: 0, removed: 0 } }, { claims: ['x'.repeat(2049)] },
      { evidence: [{ kind: 'diff', ref: 'a', capturedBy: 'agent', sha256: 'wrong' }] },
      { verification: [{ cmd: 'test', exitCode: 0.5, summary: 'bad' }] }]) {
      expect(proofEnvelopeSchema.safeParse({ ...f.envelope, ...changed }).success).toBe(false);
    }
    expect(() => serializeProofEnvelope({ ...f.envelope, claims: Array(32).fill('😀'.repeat(1000)) })).toThrow('byte bound');
    writeFileSync(join(f.out, 'huge.json'), ' '.repeat(PROOF_MAX_BYTES + 1));
    expect(() => readProofFile(join(f.out, 'huge.json'), PROOF_MAX_BYTES)).toThrow();
  });
  it('does not accept agent-only evidence, absent tests or fabricated command exits', () => {
    const f = fixture(); f.envelope.riskTier = 'low';
    f.envelope.evidence.forEach(e => { e.capturedBy = 'agent'; }); f.save();
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/agent assertion/);
    expect(verifyProofResult(f.result).ok).toBe(false);
    f.envelope.evidence.forEach(e => { e.capturedBy = 'tool'; });
    f.envelope.verification[0]!.exitCode = 1; f.save();
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/command failed/);
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/mismatched tool receipt/);
    const noTest = join(f.out, 'empty.proof.json'); capturePublishProof({ repo: f.repo, gitDir: join(f.repo, '.git'), layout: 'repo', base: f.base, output: noTest });
    expect(verifyProofResult(noTest).flags).toContain('Missing command verification');
  });
  it('flags modified envelopes, missing artifacts, wrong stats, traversal, symlinks and duplicate markers', () => {
    const f = fixture();
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + ' ');
    expect(verifyProofResult(f.result).ok).toBe(false);
    f.envelope.diffStats.added = 999; f.save();
    expect(verifyProofResult(f.result).flags).toContain('Missing or mismatched diff statistics receipt');
    f.envelope.evidence[0]!.ref = '../runner.log'; f.save();
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/nonlocal reference/);
    f.envelope.evidence[0]!.ref = 'J.proof.json.diff'; f.save();
    const patch = join(f.out, 'J.proof.json.diff'); writeFileSync(patch, 'tampered');
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/digest mismatch/);
    rmSync(patch); symlinkSync(f.log, patch);
    expect(verifyProofResult(f.result).flags.join('\n')).toMatch(/unreadable artifact/);
    writeFileSync(f.result, readFileSync(f.result, 'utf8').repeat(2));
    expect(verifyProofResult(f.result).ok).toBe(false);
    expect(() => capturePublishProof({ repo: f.repo, gitDir: join(f.repo, '.git'), layout: 'repo', base: f.base, output: f.file })).toThrow();
  });
  it('redacts home paths and secrets in notes, commands and artifacts, while preserving digest fields', () => {
    const f = fixture(); const secret = 'ghp_' + 'a'.repeat(36);
    writeFileSync(f.log, `/Users/alice/project /home/bob/repo ${secret} password=abc\n`);
    const dest = join(f.out, 'private.proof.json');
    capturePublishProof({ repo: f.repo, gitDir: join(f.repo, '.git'), layout: 'repo', base: f.base, output: dest, test: { cmd: 'npm test /Users/alice/repo', exitCode: 0, log: f.log } });
    const output = readFileSync(dest, 'utf8') + readFileSync(`${dest}.test.log`, 'utf8');
    expect(output).not.toMatch(/alice|bob|ghp_|password=abc/);
    expect(output).toContain('~/repo');
    expect(JSON.parse(readFileSync(dest, 'utf8')).evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    f.envelope.claims = [`${secret} /Users/alice/private`];
    expect(serializeProofEnvelope(f.envelope)).not.toMatch(/alice|ghp_/);
  });
  it('renders review JSON, rejects invalid CLI input and never runs verification commands', async () => {
    const f = fixture(); const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.envelope.verification[0]!.cmd = 'touch NEVER_EXECUTE'; f.save();
    expect(await cmdFleetProof(['verify', f.result, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0]).schema).toBe('fleet.proof-review.v1');
    expect(await cmdFleetProof(['verify', f.result, '--apply'])).toBe(2);
    expect(await cmdFleetProof(['capture', '--repo', f.repo])).toBe(2);
    expect(await cmdFleetProof(['capture', '--repo', f.repo, '--git-dir', join(f.repo, '.git'), '--layout', 'repo', '--base', f.base, '--output', join(f.out, 'cli.json')])).toBe(0);
    expect(output.mock.calls.at(-1)![0]).toMatch(/^PROOF cli.json sha256:/);
    expect(await cmdFleetProof(['verify', join(f.root, 'missing')])).toBe(1);
    expect(existsSync(join(f.repo, 'NEVER_EXECUTE'))).toBe(false);
  });
});

it('runs the actual publisher capture hook with runner output and exits, before commit/push', () => {
  const f = fixture();
  const source = readFileSync(new URL('../contrib/mac/publish.sh', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('PROOF_GITDIR='), source.indexOf('\nif [ "$IM" = 0 ]; then', source.indexOf('PROOF_GITDIR=')));
  expect(hook).toContain('phm "${PROOF_ARGS[@]}"');
  const linked = join(f.root, 'linked');
  execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', linked, f.base], { stdio: 'pipe' });
  writeFileSync(join(linked, 'source.txt'), 'captured through linked worktree\n');
  execFileSync('git', ['-C', linked, 'add', '.'], { stdio: 'pipe' });
  const entry = join(f.root, 'hook-cli.mjs');
  const moduleUrl = new URL('../src/cli/fleet-proof.ts', import.meta.url).href;
  writeFileSync(entry, `import {cmdFleetProof} from ${JSON.stringify(moduleUrl)}; process.exitCode = await cmdFleetProof(process.argv.slice(4));`);
  const run = spawnSync('/bin/bash', ['-c', `
    git(){ command git -C "$WT" "$@"; }
    phm(){ "$PROOF_NODE" --import tsx "$PROOF_ENTRY" "$@"; }
    TC='fixture runner'; "$PROOF_NODE" -e 'console.log("actual failure output");process.exit(7)' > "$R/$J.test.log"; rc=$?
    ${hook}
  `], { cwd: process.cwd(), env: { ...process.env, J: 'hook', R: f.out, WT: linked, BASE: f.base, PROOF_NODE: process.execPath, PROOF_ENTRY: entry }, encoding: 'utf8', timeout: 30_000 });
  expect(run.status, run.stderr).toBe(0);
  const marker = /^PROOF (\S+) sha256:([a-f0-9]{64})$/m.exec(run.stdout)!;
  expect(marker).not.toBeNull();
  const envelope = JSON.parse(readFileSync(join(f.out, marker[1]!), 'utf8')) as ProofEnvelope;
  expect(envelope.verification[0]).toMatchObject({ cmd: 'fixture runner', exitCode: 7 });
  const artifact = envelope.evidence.find(e => e.kind === 'test-output')!;
  expect(readFileSync(join(f.out, artifact.ref), 'utf8')).toContain('actual failure output');
  const result = join(f.out, 'hook.publish'); writeFileSync(result, run.stdout);
  expect(verifyProofResult(result).flags.join('\n')).toContain('command failed (exit 7)');
  expect(source.indexOf('phm "${PROOF_ARGS[@]}"')).toBeLessThan(source.indexOf('commit -q --no-verify'));
  expect(source).toContain('RESULT ABORT proof-tree-changed');
});
