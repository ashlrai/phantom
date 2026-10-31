#!/usr/bin/env -S npx tsx
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';

const USAGE = 'Usage: npx tsx examples/agents/job-release-evidence.ts --job ID --repo PATH (--tag TAG | --candidate-ref REF) [--merge-sha SHA]';
const SHA = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TIMEOUT_MS = 5000;

type GitResult = { code: number | null; stdout: string };
type Git = (repo: string, args: string[]) => Promise<GitResult>;
export interface JobReleaseEvidenceDependencies {
  read?: (job: string) => Promise<FleetJobDetailV1>;
  git?: Git;
  write?: (text: string) => void;
}

/** Run local, bounded Git reads without inherited Git overrides or lazy network fetches. */
const runGit: Git = (repo, args) => new Promise(resolveResult => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0',
  });
  execFile('git', args, { cwd: repo, env, timeout: TIMEOUT_MS, maxBuffer: 4096, encoding: 'utf8' }, (error, stdout) => {
    const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
    resolveResult({ code, stdout });
  });
});

function validCandidateRef(ref: string): boolean {
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) return false;
  return ref.length <= 200 && !ref.endsWith('/') && !ref.endsWith('.')
    && !ref.includes('..') && !ref.includes('//') && !ref.includes('@{')
    && !/[\s~^:?*\[\\]/u.test(ref)
    && ref.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function parseArgs(args: readonly string[]): { job: string; repo: string; target: { kind: 'tag' | 'candidate-ref'; ref: string }; mergeSha?: string } | null {
  const values: Record<string, string> = {};
  if (args.length > 8 || args.length % 2 !== 0) return null;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1]!;
    // Reject control bytes, including newlines, in every user-supplied value.
    if (!['--job', '--repo', '--tag', '--candidate-ref', '--merge-sha'].includes(key) || Object.hasOwn(values, key)
      || !value || value.startsWith('-') || value.length > 4096
      // eslint-disable-next-line no-control-regex -- control bytes are invalid input.
      || /[\x00-\x1f\x7f]/.test(value)) return null;
    values[key] = value;
  }
  const job = values['--job'];
  const repo = values['--repo'];
  const tag = values['--tag'];
  const candidateRef = values['--candidate-ref'];
  const mergeSha = values['--merge-sha'];
  if (!job || !isFleetJobId(job) || !repo || Boolean(tag) === Boolean(candidateRef)
    || (tag !== undefined && (!TAG.test(tag) || tag.includes('..') || tag.includes('//') || tag.endsWith('.') || tag.endsWith('/')
      || tag.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))))
    || (candidateRef !== undefined && !validCandidateRef(candidateRef))
    || (mergeSha !== undefined && !SHA.test(mergeSha))) return null;
  return { job, repo, target: tag ? { kind: 'tag', ref: `refs/tags/${tag}` } : { kind: 'candidate-ref', ref: candidateRef! }, mergeSha };
}

/** The caller asserts that mergeSha belongs to the job; Git only proves ancestry. */
export async function runJobReleaseEvidence(args: readonly string[], deps: JobReleaseEvidenceDependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  if (args.length === 1 && args[0] === '--help') { write(`${USAGE}\n`); return 0; }
  const options = parseArgs(args);
  if (!options) { emit({ error: USAGE }); return 2; }
  const git = deps.git ?? runGit;
  try {
    const detail = await (deps.read ?? getFleetJobDetail)(options.job);
    // rev-parse can DWIM an absent fully qualified ref into another namespace.
    // For candidate refs, verify the exact name first and peel the returned object ID.
    const exactRef = options.target.kind === 'candidate-ref'
      ? await git(options.repo, ['show-ref', '--verify', '--hash', '--', options.target.ref]) : null;
    const object = exactRef?.stdout.trim();
    const targetResult = options.target.kind === 'tag' || (exactRef?.code === 0 && object && SHA.test(object))
      ? await git(options.repo, ['rev-parse', '--verify', '--end-of-options', `${object ?? options.target.ref}^{commit}`]) : null;
    const candidate = targetResult?.stdout.trim();
    const targetSha = targetResult?.code === 0 && candidate && SHA.test(candidate) ? candidate.toLowerCase() : null;
    const targetName = options.target.kind === 'tag' ? 'tag' : 'candidate ref';
    const result = (status: 'included' | 'not-included' | 'unknown', reason: string) => {
      emit({ schema: 'fleet.job.release-evidence.v1', job: options.job, status, reason,
        ...(options.target.kind === 'tag' ? { tagSha: targetSha } : {}),
        target: { ...options.target, sha: targetSha },
        sources: { base: detail.sources.base, publish: detail.sources.publish }, jobState: detail.state });
      return status === 'included' ? 0 : status === 'not-included' ? 3 : 4;
    };
    if (!targetSha) return result('unknown', `${options.target.kind === 'tag' ? 'Tag' : 'Candidate ref'} could not be resolved to a local commit.`);
    if (detail.sources.base === 'degraded' || detail.sources.publish === 'degraded') return result('unknown', 'Job base or publish evidence is degraded.');
    if (detail.state === 'running') return result('unknown', 'Job is running; publish evidence may belong to an earlier attempt.');
    if (detail.sources.base !== 'healthy' && detail.sources.publish !== 'healthy') return result('unknown', 'No readable job base or publish evidence.');
    if (!options.mergeSha) return result('unknown', 'A base SHA or PR URL does not prove a merge; supply a verified --merge-sha.');
    const merge = await git(options.repo, ['rev-parse', '--verify', '--end-of-options', `${options.mergeSha}^{commit}`]);
    if (merge.code !== 0 || !SHA.test(merge.stdout.trim())) return result('unknown', 'Merge commit could not be resolved locally.');
    const mergeSha = merge.stdout.trim().toLowerCase();
    const ancestry = await git(options.repo, ['merge-base', '--is-ancestor', mergeSha, targetSha]);
    if (ancestry.code === 0) return result('included', `The supplied merge commit is an ancestor of the ${targetName}.`);
    if (ancestry.code !== 1) return result('unknown', 'Commit ancestry could not be checked locally.');
    const shallow = await git(options.repo, ['rev-parse', '--is-shallow-repository']);
    if (shallow.code !== 0 || shallow.stdout.trim() !== 'false') return result('unknown', 'Repository history may be incomplete.');
    return result('not-included', `The supplied merge commit is not an ancestor of the ${targetName}.`);
  } catch {
    emit({ error: 'Unable to read job release evidence.' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobReleaseEvidence(process.argv.slice(2));
}
