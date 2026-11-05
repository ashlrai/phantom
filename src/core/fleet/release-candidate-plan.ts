/**
 * Read-only release-candidate recovery planner (RQ-PHX-RELEASECANDIDATEPLAN05SRH1).
 * Correlates evidence for a release blocked because master moved between the CI
 * gate and attestation. The real contract, read from origin/master: ci.yml
 * qualifies a candidate via a completed workflow_dispatch/schedule run whose
 * "Desktop release smoke" job uploads `ashlr-build-<run>-<attempt>`; the
 * attest-ci-build.yml dispatch takes ci_run_id, ci_run_attempt, candidate_sha
 * and build_artifact_id, then asserts the CURRENT master head's tree equals the
 * candidate's tree — else "trusted master tree differs from candidate", the
 * master-moved mismatch. Evidence on another SHA never counts; missing or
 * ambiguous evidence stays unknown. Nothing is dispatched or mutated.
 */

import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const TIMEOUT_MS = 30_000;
const META_MAX = 1024 * 1024;
const LIST_MAX = 4 * 1024 * 1024;
const MAX_REPORTED = 5;
const MAX_FIELD = 200;
const SHA = /^[a-f0-9]{40}$/;
const CI_PATH = '.github/workflows/ci.yml';
const ATTEST_PATH = '.github/workflows/attest-ci-build.yml';
const GATE_EVENTS = new Set(['workflow_dispatch', 'schedule']);

export interface RunFact { id: number; attempt: number | null; status: string; conclusion: string | null; headSha: string; event: string | null }
export interface Blocker { id: string; detail: string }
export interface NextAction { kind: 'read' | 'dispatch' | 'owner'; summary: string; command?: string }

export interface ReleaseCandidatePlan {
  version: 1;
  repo: string;
  tag: string;
  /** released > blocked > unavailable > unknown > ready. */
  outcome: 'released' | 'ready' | 'blocked' | 'unknown' | 'unavailable';
  candidate: { sha: string | null; tree: string | null };
  master: { branch: string | null; sha: string | null; tree: string | null };
  /** Head commit/tree comparisons; null while either side is unknown. */
  masterMoved: boolean | null;
  treeMatch: boolean | null;
  /** Latest completed ci.yml dispatch/schedule (gate) run ON the candidate sha. */
  gateRun: RunFact | null;
  ciRunsPending: number | null;
  /** Attest runs with head_sha = candidate, and recent attest runs on master at any sha. */
  attestOnCandidate: RunFact[];
  attestRecent: RunFact[];
  producerArtifact: { id: number; name: string; digest: string | null; expired: boolean } | 'unknown' | null;
  release: { state: 'published' | 'draft' | 'missing' | 'unknown'; id: number | null; draft: boolean | null; prerelease: boolean | null; assets: number | null; targetCommitish: string | null };
  blockers: Blocker[];
  nextActions: NextAction[];
  truncated: boolean;
}

const clean = (value: string): string =>
  // eslint-disable-next-line no-control-regex
  scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')).slice(0, MAX_FIELD);
const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const hex = (v: unknown): string | null => typeof v === 'string' && SHA.test(v) ? v : null;
const short = (v: string | null): string => v ? v.slice(0, 12) : 'unknown';

type ApiState = 'ok' | 'notfound' | 'unavailable' | 'invalid';
async function api(runner: GitRunner, path: string, max: number, flags: { truncated: boolean }): Promise<{ state: ApiState; json: unknown }> {
  try {
    const res = await runner('gh', ['api', path], { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes: max });
    if (res.truncated) { flags.truncated = true; return { state: 'invalid', json: null }; }
    if (res.timedOut || res.missing || res.code === null) return { state: 'unavailable', json: null };
    if (res.code !== 0) return { state: /HTTP 404/.test(res.stderr) ? 'notfound' : 'unavailable', json: null };
    try { return { state: 'ok', json: JSON.parse(res.stdout) }; } catch { return { state: 'invalid', json: null }; }
  } catch { return { state: 'unavailable', json: null }; }
}

/** Strict run-row parse: identity, source sha and workflow path must all agree. */
function runFact(row: unknown, path: string, wantSha: string | null): RunFact | 'invalid' | 'skip' {
  const m = rec(row);
  const num = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
  if (!m || !num(m['id']) || !num(m['run_attempt']) || hex(m['head_sha']) === null
    || typeof m['status'] !== 'string' || !m['status'] || typeof m['event'] !== 'string' || !m['event']
    || (m['conclusion'] !== null && typeof m['conclusion'] !== 'string')) return 'invalid';
  if (m['path'] !== path || m['head_branch'] !== 'master' || (wantSha !== null && m['head_sha'] !== wantSha)) return 'skip';
  return {
    id: m['id'] as number, attempt: m['run_attempt'] as number, status: clean(m['status'] as string),
    conclusion: m['conclusion'] === null ? null : clean(m['conclusion']), headSha: m['head_sha'] as string,
    event: clean(m['event'] as string),
  };
}

/** A runs page is an inventory only when it holds the whole total_count. */
async function fetchRuns(runner: GitRunner, query: string, path: string, wantSha: string | null, complete: boolean, flags: { truncated: boolean }): Promise<RunFact[] | 'invalid'> {
  const res = await api(runner, query, LIST_MAX, flags);
  const m = rec(res.json);
  if (res.state !== 'ok' || !m || !Number.isSafeInteger(m['total_count']) || !Array.isArray(m['workflow_runs'])) return 'invalid';
  if (complete && m['total_count'] !== m['workflow_runs'].length) return 'invalid';
  const out: RunFact[] = [];
  for (const row of m['workflow_runs']) {
    const fact = runFact(row, path, wantSha);
    if (fact === 'invalid') return 'invalid';
    if (fact !== 'skip') out.push(fact);
  }
  return out.sort((a, b) => b.id - a.id || (b.attempt ?? 0) - (a.attempt ?? 0));
}

/** Drafts are invisible on the tags endpoint, so the release list is scanned;
 * a published row beats any draft for the tag, then highest id wins. */
function scanRelease(json: unknown, tag: string): ReleaseCandidatePlan['release'] | 'unknown' {
  if (!Array.isArray(json)) return 'unknown';
  let match: Record<string, unknown> | null = null;
  for (const row of json) {
    const r = rec(row);
    if (!r || r['tag_name'] !== tag) continue;
    if (!Number.isSafeInteger(r['id']) || typeof r['draft'] !== 'boolean' || typeof r['prerelease'] !== 'boolean') return 'unknown';
    if (match === null || (match['draft'] === r['draft'] ? (r['id'] as number) > (match['id'] as number) : match['draft'])) match = r;
  }
  if (match === null) return json.length >= 100 ? 'unknown' : { state: 'missing', id: null, draft: null, prerelease: null, assets: null, targetCommitish: null };
  return {
    state: match['draft'] === true ? 'draft' : 'published', id: match['id'] as number,
    draft: match['draft'] as boolean, prerelease: match['prerelease'] as boolean,
    assets: Array.isArray(match['assets']) ? match['assets'].length : null,
    targetCommitish: typeof match['target_commitish'] === 'string' ? clean(match['target_commitish']) : null,
  };
}

export async function planReleaseCandidate(repo: string, tag: string, opts: { runner?: GitRunner } = {}): Promise<ReleaseCandidatePlan> {
  const runner = opts.runner ?? defaultGitRunner;
  const flags = { truncated: false };
  const base = `repos/${repo}`;
  const plan: ReleaseCandidatePlan = {
    version: 1, repo, tag, outcome: 'unavailable',
    candidate: { sha: null, tree: null },
    master: { branch: null, sha: null, tree: null },
    masterMoved: null, treeMatch: null,
    gateRun: null, ciRunsPending: null,
    attestOnCandidate: [], attestRecent: [], producerArtifact: null,
    release: { state: 'unknown', id: null, draft: null, prerelease: null, assets: null, targetCommitish: null },
    blockers: [], nextActions: [], truncated: false,
  };
  const blockers = plan.blockers;
  const unknowns: string[] = [];
  let requiredFailed = false;

  const repoMeta = await api(runner, base, META_MAX, flags);
  const repoRow = rec(repoMeta.json);
  if (repoMeta.state === 'ok' && repoRow && repoRow['full_name'] === repo && typeof repoRow['default_branch'] === 'string') {
    plan.master.branch = repoRow['default_branch'];
  } else requiredFailed = true;

  // Tag -> commit; annotated tags get exactly one dereference hop.
  const ref = await api(runner, `${base}/git/ref/tags/${tag}`, META_MAX, flags);
  let tagMissing = false;
  if (ref.state === 'notfound') tagMissing = true;
  else if (ref.state !== 'ok') requiredFailed = true;
  else {
    let obj = rec(rec(ref.json)?.['object']);
    if (obj?.['type'] === 'tag' && hex(obj['sha'])) {
      const tagObj = await api(runner, `${base}/git/tags/${hex(obj['sha'])}`, META_MAX, flags);
      obj = tagObj.state === 'ok' ? rec(rec(tagObj.json)?.['object']) : null;
    }
    plan.candidate.sha = obj?.['type'] === 'commit' ? hex(obj['sha']) : null;
    if (plan.candidate.sha === null) requiredFailed = true;
  }

  // Candidate tree and current master head tree — the attestation bind.
  if (plan.candidate.sha) {
    const commit = await api(runner, `${base}/git/commits/${plan.candidate.sha}`, META_MAX, flags);
    const row = rec(commit.json);
    if (commit.state === 'ok' && row?.['sha'] === plan.candidate.sha && hex(rec(row['tree'])?.['sha'])) {
      plan.candidate.tree = hex(rec(row['tree'])?.['sha']);
    } else requiredFailed = true;
  }
  if (plan.master.branch) {
    const branch = await api(runner, `${base}/branches/${plan.master.branch}`, META_MAX, flags);
    const commit = rec(rec(branch.json)?.['commit']);
    const tree = hex(rec(rec(commit?.['commit'])?.['tree'])?.['sha']);
    if (branch.state === 'ok' && hex(commit?.['sha']) && tree) {
      plan.master.sha = hex(commit?.['sha']); plan.master.tree = tree;
    } else requiredFailed = true;
  }
  plan.masterMoved = plan.candidate.sha !== null && plan.master.sha !== null ? plan.candidate.sha !== plan.master.sha : null;
  plan.treeMatch = plan.candidate.tree !== null && plan.master.tree !== null ? plan.candidate.tree === plan.master.tree : null;

  const releases = await api(runner, `${base}/releases?per_page=100&page=1`, LIST_MAX, flags);
  const release = releases.state === 'ok' ? scanRelease(releases.json, tag) : 'unknown';
  if (release === 'unknown') { plan.release.state = 'unknown'; unknowns.push('release'); }
  else plan.release = release;

  const cand = plan.candidate.sha;
  if (cand) {
    const ciRuns = await fetchRuns(runner, `${base}/actions/workflows/ci.yml/runs?head_sha=${cand}&branch=master&per_page=100`, CI_PATH, cand, true, flags);
    if (ciRuns === 'invalid') unknowns.push('ci_runs');
    else {
      const completed = ciRuns.filter(r => r.status === 'completed');
      plan.ciRunsPending = ciRuns.length - completed.length;
      plan.gateRun = completed.find(r => GATE_EVENTS.has(r.event ?? '')) ?? null;
    }
  }
  // One bounded attest inventory serves both views: runs while master head WAS
  // the candidate (head_sha = cand) and the recent runs on any master sha.
  const attRuns = await fetchRuns(runner, `${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`, ATTEST_PATH, null, true, flags);
  if (attRuns === 'invalid') unknowns.push('attest_runs');
  else {
    plan.attestOnCandidate = (cand ? attRuns.filter(r => r.headSha === cand) : []).slice(0, MAX_REPORTED);
    plan.attestRecent = attRuns.slice(0, MAX_REPORTED);
  }

  // Immutable producer artifact for a green gate run.
  if (plan.gateRun?.conclusion === 'success' && plan.gateRun.attempt !== null) {
    const expected = `ashlr-build-${plan.gateRun.id}-${plan.gateRun.attempt}`;
    const arts = await api(runner, `${base}/actions/runs/${plan.gateRun.id}/artifacts?per_page=100`, LIST_MAX, flags);
    const body = rec(arts.json);
    const found = arts.state === 'ok' && body && Number.isSafeInteger(body['total_count']) && Array.isArray(body['artifacts'])
      && body['total_count'] === body['artifacts'].length
      ? (body['artifacts'] as unknown[]).map(rec).filter(a => a?.['name'] === expected) : null;
    if (found === null || found.length > 1) plan.producerArtifact = 'unknown';
    else if (found.length === 1) {
      const a = found[0]!;
      plan.producerArtifact = Number.isSafeInteger(a['id']) && (a['id'] as number) > 0 && typeof a['expired'] === 'boolean'
        ? { id: a['id'] as number, name: expected, digest: typeof a['digest'] === 'string' ? clean(a['digest']) : null, expired: a['expired'] as boolean }
        : 'unknown';
    }
    if (plan.producerArtifact === 'unknown') unknowns.push('producer_artifact');
  }

  // ---- Correlation -------------------------------------------------------
  const block = (id: string, detail: string, when: unknown): void => { if (when) blockers.push({ id, detail }); };
  const attested = plan.attestOnCandidate.find(r => r.conclusion === 'success');
  const attestLatest = plan.attestOnCandidate[0];
  const artifact = plan.producerArtifact === 'unknown' ? null : plan.producerArtifact;
  block('tag_missing', `tag ${tag} not found in ${repo}; tags and draft releases are created only by the protected auto-tag lane`, tagMissing);
  // Once a candidate is attested the evidence is bound; a moved master can no
  // longer block it — only the downstream publish lane remains.
  block('master_tree_mismatch', `master ${short(plan.master.sha)} tree ${short(plan.master.tree)} differs from candidate ${short(cand)} tree ${short(plan.candidate.tree)} ("trusted master tree differs from candidate"); master moved between gate and attestation`,
    plan.masterMoved === true && plan.treeMatch === false && !attested);
  block('no_gate_run', `no completed workflow_dispatch/schedule ci.yml run exists on candidate ${short(cand)}; the attestation lane has no qualified build to bind`,
    cand && plan.gateRun === null && plan.ciRunsPending === 0 && !unknowns.includes('ci_runs') && !attested);
  block('gate_failed', `latest gate run ${plan.gateRun?.id} attempt ${plan.gateRun?.attempt} on ${short(cand)} concluded ${plan.gateRun?.conclusion ?? 'unknown'}`, plan.gateRun !== null && plan.gateRun.conclusion !== 'success' && !attested);
  block('producer_artifact_missing', `gate run ${plan.gateRun?.id} succeeded but artifact ashlr-build-${plan.gateRun?.id}-${plan.gateRun?.attempt} is absent`, plan.gateRun?.conclusion === 'success' && plan.producerArtifact === null && !attested);
  block('producer_artifact_expired', `artifact ${artifact?.name} is expired; the immutable build is no longer fetchable`, artifact?.expired === true && !attested);
  block('attestation_failed', `latest attest run ${attestLatest?.id} attempt ${attestLatest?.attempt} on candidate ${short(cand)} concluded ${attestLatest?.conclusion ?? 'unknown'}`,
    attestLatest && attestLatest.status === 'completed' && attestLatest.conclusion !== 'success' && !attested);
  block('release_target_differs', `release ${plan.release.id} targets ${short(plan.release.targetCommitish)}, not candidate ${short(cand)}`,
    plan.release.targetCommitish !== null && cand !== null && SHA.test(plan.release.targetCommitish) && plan.release.targetCommitish !== cand);

  // ---- Next actions ------------------------------------------------------
  const dispatchable = cand !== null && plan.treeMatch === true && plan.gateRun?.conclusion === 'success' && !attested && artifact !== null && !artifact.expired;
  if (blockers.length) {
    plan.nextActions.push({ kind: 'owner', summary: 'the release owner must bind the gate and attestation to one immutable candidate under the existing signing policy; this planner offers no bypass and never mutates queues, tags, workflows or checks' });
  } else if (dispatchable && artifact) {
    plan.nextActions.push({
      kind: 'dispatch',
      summary: 'owner dispatch: bind attestation to this exact immutable candidate (existing attest-ci-build.yml inputs only; the planner never sends it)',
      command: `gh workflow run attest-ci-build.yml --repo ${repo} --ref ${plan.master.branch} -f ci_run_id=${plan.gateRun!.id} -f ci_run_attempt=${plan.gateRun!.attempt} -f candidate_sha=${cand} -f build_artifact_id=${artifact.id}`,
    });
  } else if (attested && plan.release.state !== 'published') {
    plan.nextActions.push({ kind: 'owner', summary: `candidate is attested (run ${attested.id}); publish-canonical-npm still needs the protected attested-artifact and audit inputs — continue under the release owner lane` });
  }
  if (plan.ciRunsPending) plan.nextActions.push({ kind: 'owner', summary: `${plan.ciRunsPending} ci.yml run(s) still in progress on the candidate; re-check after they complete` });
  const rerun = plan.gateRun?.id ?? plan.attestRecent[0]?.id;
  const reads: NextAction[] = [{ kind: 'read', summary: 'recent attestation runs on master', command: `gh api ${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=10` }];
  if (blockers.length && rerun) reads.push({ kind: 'read', summary: `re-read run ${rerun} metadata`, command: `gh api ${base}/actions/runs/${rerun}` });
  reads.push({ kind: 'read', summary: 'release rows for this tag (drafts included)', command: `gh api ${base}/releases?per_page=10` });
  plan.nextActions.push(...reads);

  plan.truncated = flags.truncated;
  if (plan.release.state === 'published') plan.outcome = 'released';
  else if (blockers.length) plan.outcome = 'blocked';
  else if (requiredFailed) plan.outcome = 'unavailable';
  else if (unknowns.length) plan.outcome = 'unknown';
  else plan.outcome = 'ready';
  return plan;
}
