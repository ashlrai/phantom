/** Capture controller for the trusted bridge publisher. Imported test receipts
 * must come from that publisher's actual runner, never parsed agent notes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { runSafeGitSync, type SafeGitTarget } from '../sandbox/safe-git.js';
import { localProofRef, PROOF_ARTIFACT_MAX_BYTES, proofHash, readProofFile, redactProofText,
  serializeProofEnvelope, type ProofEnvelope } from './proof-envelope.js';

export interface CaptureProofInput {
  repo: string;
  base: string;
  gitDir: string;
  layout?: SafeGitTarget['layout'];
  output: string;
  /** Only set together by the trusted publisher after its runner finishes. */
  test?: { cmd: string; exitCode: number; log: string };
}

/** Captures the staged tree against the dispatcher's pinned base. Git external
 * diff/textconv are disabled. A failed or truncated command never becomes proof. */
export function capturePublishProof(input: CaptureProofInput): { file: string; sha256: string } {
  if (!/^[a-f0-9]{40}$/.test(input.base)) throw new Error('Expected pinned base SHA');
  const file = resolve(input.output), name = basename(file);
  if (!localProofRef(name) || name.length > 140) throw new Error('Invalid proof filename');
  const git = (args: string[]) => {
    const result = runSafeGitSync({ workTree: resolve(input.repo), gitDir: resolve(input.gitDir),
      layout: input.layout ?? 'linked', args, timeoutMs: 30_000,
      maxOutputBytes: PROOF_ARTIFACT_MAX_BYTES, noOptionalLocks: true });
    if (!result.ok) throw new Error('Git evidence unavailable or exceeds capture bound');
    return result.stdout;
  };
  const tree = git(['write-tree']).trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error('Staged tree unavailable');
  const patch = git(['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', input.base, tree, '--']);
  const numstat = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z', input.base, tree, '--']);
  const diffStats = { files: 0, added: 0, removed: 0 };
  for (const row of numstat.split('\0').filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(row);
    if (!match) throw new Error('Invalid git diff statistics');
    diffStats.files++; diffStats.added += match[1] === '-' ? 0 : Number(match[1]); diffStats.removed += match[2] === '-' ? 0 : Number(match[2]);
  }
  const envelope: ProofEnvelope = { schema: 'fleet.proof.v1', claims: [], evidence: [], verification: [], diffStats,
    riskTier: 'unknown', reviewerChecklist: [
      'Verify the publisher marker digest and tool artifact hashes.',
      'Review the pinned base and staged tree in the diff receipt against the PR.',
      'Classify risk and check that recorded tests cover the changed behavior.',
      'Tool provenance depends on the trusted publisher; hashes do not attest execution.',
    ] };
  const artifacts: { path: string; content: string }[] = [];
  const add = (kind: ProofEnvelope['evidence'][number]['kind'], suffix: string, content: string) => {
    const safe = redactProofText(content);
    if (Buffer.byteLength(safe) > PROOF_ARTIFACT_MAX_BYTES) throw new Error('Evidence exceeds capture bound');
    const ref = `${name}.${suffix}`;
    const sha256 = proofHash(safe);
    artifacts.push({ path: resolve(dirname(file), ref), content: safe });
    envelope.evidence.push({ kind, ref, sha256, capturedBy: 'tool' });
    return sha256;
  };
  const patchSha256 = add('diff', 'diff', patch);
  // Preserve digests through the generic free-text scrub by encoding only the
  // nonsecret machine receipt after its free-text fields have been scrubbed.
  const receipt = (suffix: string, value: unknown) => {
    const content = JSON.stringify(value) + '\n';
    const ref = `${name}.${suffix}`;
    artifacts.push({ path: resolve(dirname(file), ref), content });
    envelope.evidence.push({ kind: 'state-diff', ref, sha256: proofHash(content), capturedBy: 'tool' });
  };
  receipt('git.json', { base: input.base, tree, patchSha256, diffStats });
  if (input.test) {
    const { exitCode } = input.test;
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error('Invalid runner exit code');
    const cmd = redactProofText(input.test.cmd);
    const outputSha256 = add('test-output', 'test.log', readProofFile(input.test.log, PROOF_ARTIFACT_MAX_BYTES));
    envelope.verification.push({ cmd, exitCode, summary: 'Publisher runner exit; inspect hashed test output for scope.' });
    receipt('test.json', { cmd, exitCode, outputSha256 });
  }
  const serialized = serializeProofEnvelope(envelope);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Exclusive writes prevent stale bundle reuse and refuse symlink destinations.
  // Publish the envelope last so partial captures cannot appear complete.
  for (const artifact of artifacts) writeFileSync(artifact.path, artifact.content, { mode: 0o600, flag: 'wx' });
  writeFileSync(file, serialized, { mode: 0o600, flag: 'wx' });
  return { file: name, sha256: proofHash(serialized) };
}
