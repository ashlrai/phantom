/* global process, console, fetch, AbortSignal, Buffer */
// Source-identical history fast-path proof for the Quick job.
//
// This module is executed ONLY from bytes fetched out of the authenticated
// canonical base tip by the fixed workflow bootstrap — never from the
// candidate checkout, so candidate source cannot decide its own exemption.
// It prints exactly `equal` or `fallback` on stdout. Every unknown, malformed,
// drifted, mismatched or unavailable input is a fallback, and fallback always
// runs the unchanged normal Quick steps. The proof compares the exact whole
// tracked Git tree of the checked-out candidate with the tree of the current
// canonical default-branch tip; it is a feedback fast path only and never
// qualifies release artifacts or reuses an earlier result.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HUB_REPOSITORY_IDENTITY,
  requireProducerEnvironment,
  requireRepositoryMetadata,
} from './github-repository-binding.mjs';

const SHA = /^[a-f0-9]{40}$/;
const FAST_EVENTS = new Set(['pull_request', 'merge_group']);
const API_ORIGIN = 'https://api.github.com';
const API_TIMEOUT_MS = 10_000;
const MAX_API_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_GIT_BYTES = 4 * 1024 * 1024;
// Read-only plumbing only: no optional index locks, no replace/graft object
// substitution, argv arrays only — never a shell, diff, textconv or fetch.
const GIT_PREFIX = ['--no-optional-locks', '--no-replace-objects'];

export class HistoryProofFallback extends Error {}

const object = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null);
const exactSha = (value) => {
  if (typeof value !== 'string' || !SHA.test(value)) throw new HistoryProofFallback('invalid 40-hex revision');
  return value;
};
const refusal = (message) => new HistoryProofFallback(message);

function defaultGit(root) {
  return (args) => execFileSync('git', [...GIT_PREFIX, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_GIT_BYTES, timeout: 10_000,
  }).trim();
}

function defaultReadEvent(path) {
  if (typeof path !== 'string' || path.length === 0) throw refusal('missing event payload path');
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_EVENT_BYTES) throw refusal('event payload size outside bound');
  return readFileSync(path, 'utf8');
}

// Bounded read-only GET against the fixed official API origin. The token is
// the job's existing contents:read github.token context; no other credential,
// host or method is reachable through this reader.
export async function githubApiRead(path, env, fetchImpl = fetch) {
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  if (typeof token !== 'string' || token.length === 0) throw refusal('missing canonical API token');
  if (typeof path !== 'string' || !/^repos\/ashlrai\/(?:phantom|ashlr-hub)(?:\/(?:branches\/master|git\/(?:ref\/heads\/master|commits\/[0-9a-f]{40})))?$/.test(path)) throw refusal('non-canonical API path refused');
  const response = await fetchImpl(`${API_ORIGIN}/${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw refusal(`canonical API unavailable (${response.status})`);
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') throw refusal('canonical API body unavailable');
  const reader = body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_API_BYTES) throw refusal('canonical API response too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw refusal('canonical API response is not JSON');
  }
}

function eventBinding(payload, eventName, eventSha, eventRef) {
  if (eventName === 'pull_request') {
    const pr = object(payload.pull_request);
    const head = object(pr?.head);
    const base = object(pr?.base);
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 ||
        eventRef !== `refs/pull/${pr.number}/merge` ||
        (payload.number !== undefined && payload.number !== pr.number)) {
      throw refusal('pull request event ref/number binding differs');
    }
    const candidate = exactSha(head?.sha);
    const baseSha = exactSha(base?.sha);
    if (base?.ref !== HUB_REPOSITORY_IDENTITY.defaultBranch) {
      throw refusal('pull request base is not the canonical default branch');
    }
    // The base repository must be the canonical hub identity; a valid fork
    // head is allowed, so head repository identity is intentionally unchecked.
    if (object(base?.repo)?.id !== HUB_REPOSITORY_IDENTITY.repositoryId) {
      throw refusal('pull request base repository identity differs');
    }
    return { candidate, base: baseSha, mergeGroup: false };
  }
  const group = object(payload.merge_group);
  if (typeof group?.head_ref !== 'string' || group.head_ref !== eventRef ||
      !/^refs\/heads\/gh-readonly-queue\/master\/pr-[1-9][0-9]*-[0-9a-f]{40}$/.test(eventRef ?? '')) {
    throw refusal('merge group event head ref differs');
  }
  const candidate = exactSha(group?.head_sha);
  const baseSha = exactSha(group?.base_sha);
  if (candidate !== eventSha) throw refusal('merge group head differs from the event revision');
  if (group?.base_ref !== `refs/heads/${HUB_REPOSITORY_IDENTITY.defaultBranch}`) {
    throw refusal('merge group base ref is not the canonical default branch');
  }
  return { candidate, base: baseSha, mergeGroup: true };
}

async function prove({ env, api, git, readEvent, root }) {
  const eventName = env.GITHUB_EVENT_NAME;
  if (!FAST_EVENTS.has(eventName)) throw refusal(`event ${String(eventName)} is not eligible`);
  requireProducerEnvironment(env);
  const eventSha = exactSha(env.GITHUB_SHA);
  const payload = JSON.parse(readEvent(env.GITHUB_EVENT_PATH));
  const { candidate, base, mergeGroup } = eventBinding(object(payload), eventName, eventSha, env.GITHUB_REF);
  if (exactSha(env.ASHLR_HISTORY_PROOF_SOURCE_SHA) !== base) {
    throw refusal('proof source is not the exact event/canonical base');
  }
  const gitOut = git ?? defaultGit(root);

  // Exact checked-out candidate revision and a clean tracked+untracked state,
  // mirroring ci-source-binding.mjs before any exemption is considered.
  if (gitOut(['rev-parse', 'HEAD']) !== candidate) throw refusal('checkout is not the candidate revision');
  if (gitOut(['status', '--porcelain', '--untracked-files=normal']) !== '') throw refusal('source checkout is dirty');

  const repoName = env.GITHUB_REPOSITORY;
  const metadata = await api(`repos/${repoName}`);
  try { requireRepositoryMetadata(repoName, metadata); }
  catch { throw refusal('canonical repository identity differs'); }
  const ref = object(await api(`repos/${repoName}/git/ref/heads/${HUB_REPOSITORY_IDENTITY.defaultBranch}`));
  if (ref?.ref !== `refs/heads/${HUB_REPOSITORY_IDENTITY.defaultBranch}` || object(ref?.object)?.type !== 'commit') throw refusal('canonical base ref binding differs');
  // The event base must still be the current protected tip; any drift takes
  // the unchanged normal path rather than trusting a stale base.
  if (exactSha(object(ref?.object)?.sha) !== base) throw refusal('canonical base advanced past the event base');
  const branch = object(await api(`repos/${repoName}/branches/${HUB_REPOSITORY_IDENTITY.defaultBranch}`));
  if (branch?.name !== HUB_REPOSITORY_IDENTITY.defaultBranch || branch.protected !== true ||
      exactSha(object(branch.commit)?.sha) !== base) throw refusal('canonical protected branch metadata differs');
  const baseCommit = object(await api(`repos/${repoName}/git/commits/${base}`));
  if (baseCommit?.sha !== base) throw refusal('canonical base commit binding differs');
  const baseTree = exactSha(object(baseCommit?.tree)?.sha);
  const candidateCommit = object(await api(`repos/${repoName}/git/commits/${candidate}`));
  if (candidateCommit?.sha !== candidate) throw refusal('candidate commit binding differs');
  const candidateTree = exactSha(object(candidateCommit?.tree)?.sha);
  if (candidateTree !== baseTree) throw refusal('candidate tree differs from the canonical base tree');

  if (mergeGroup) {
    // A normal squash/group can have one parent; its whole tree and first
    // parent bind it independently of any historical PR head. Its first
    // parent must be the pinned canonical base and its tree already matched.
    const parents = candidateCommit.parents;
    if (!Array.isArray(parents) || parents.length < 1 || exactSha(object(parents[0])?.sha) !== base) {
      throw refusal('merge group parents differ from the canonical base');
    }
  } else if (candidate !== eventSha) {
    // pull_request GITHUB_SHA is GitHub's synthetic merge: accept only the
    // exact (base, head) parents and a merge tree equal to the base tree,
    // mirroring ci-source-binding.mjs without fetching candidate history.
    const eventCommit = object(await api(`repos/${repoName}/git/commits/${eventSha}`));
    if (eventCommit?.sha !== eventSha) throw refusal('event revision binding differs');
    const parents = eventCommit.parents;
    if (!Array.isArray(parents) || parents.length !== 2 ||
        exactSha(object(parents[0])?.sha) !== base || exactSha(object(parents[1])?.sha) !== candidate) {
      throw refusal('event merge parents differ from the event base and head');
    }
    if (exactSha(object(eventCommit?.tree)?.sha) !== baseTree) {
      throw refusal('event merge tree differs from the canonical base tree');
    }
  }

  if (gitOut(['rev-parse', 'HEAD^{tree}']) !== candidateTree) {
    throw refusal('checkout tree differs from the authenticated candidate commit');
  }
  // Re-read the canonical tip after the other observations; a source move
  // during this proof is unknown and must take the normal Quick path.
  const finalRef = object(await api(`repos/${repoName}/git/ref/heads/${HUB_REPOSITORY_IDENTITY.defaultBranch}`));
  if (finalRef?.ref !== `refs/heads/${HUB_REPOSITORY_IDENTITY.defaultBranch}` || object(finalRef?.object)?.type !== 'commit' ||
      exactSha(object(finalRef?.object)?.sha) !== base) throw refusal('canonical base changed during proof');
  return 'equal';
}

/** Returns 'equal' only after every binding above; any refusal throws. */
export async function proveHistoryFastPath({
  env = process.env,
  api,
  git,
  readEvent = defaultReadEvent,
  root = env.GITHUB_WORKSPACE ?? process.cwd(),
} = {}) {
  try {
    return await prove({
      env,
      api: api ?? ((path) => githubApiRead(path, env)),
      git,
      readEvent,
      root,
    });
  } catch (error) {
    if (error instanceof HistoryProofFallback) throw error;
    throw refusal('proof unavailable');
  }
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  let verdict = 'fallback';
  try {
    verdict = await proveHistoryFastPath({});
  } catch (error) {
    console.error(`ci-history-source fallback: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(verdict === 'equal' ? 'equal' : 'fallback');
}
