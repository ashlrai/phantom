// Supervisor hook: update one already-authorized bridge PR, then let GitHub CI
// and auto-merge enforce protection. Conflicts emit an RQ recut handoff;
// the supervisor must ingest it through fleet queue ask under its queue lock.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function eligible(pr, repo) {
  return pr.state === 'open' && pr.draft === false && Boolean(pr.auto_merge) &&
    pr.base?.repo?.full_name === repo && pr.head?.repo?.full_name === repo &&
    pr.base?.ref === 'master' && /^codex-bridge\/[A-Za-z0-9_-]+$/.test(pr.head?.ref ?? '');
}

function recut(repo, number, pr) {
  // Key by source head, not moving master: supervisor retries must not fan out
  // duplicate recuts each time another PR merges. No PR text enters the ask.
  const id = createHash('sha256').update(`${repo}:${number}:${pr.head.sha}`).digest('hex');
  return {
    status: 'recut-required', headSha: pr.head.sha,
    ask: {
      schema: 'ask.v1', id: `RQ-RECUT-${id}`, tier: 'work', pool: 'codex-personal',
      priority: 'P0', repos: [repo],
      task: `Recover conflicted bridge PR https://github.com/${repo}/pull/${number} ` +
        `(expected source head ${pr.head.sha}) through the existing RQ recut path. ` +
        'Re-read the source and existing replacements before acting; a changed source head cancels this request. ' +
        'Reuse a pending recut instead of creating another. Recut on current master, preserve the intended change, ' +
        'and rerun affected tests and required checks for the replacement head; never reuse source-head results. ' +
        'Requeue the replacement only while it remains eligible, with checks bound to its new head. ' +
        'Leave merging to the protected merge queue. ' +
        'Apply CLOSE-STALE C1-C6 before closing anything superseded; if those criteria are unavailable, ' +
        'leave the original open. No admin bypass, force-push to ashlrai branches, or ruleset changes.',
    },
  };
}

export function updateBehind(repo, number, call = (args) => JSON.parse(execFileSync(
  'locus', ['exec', '--', 'gh', ...args],
  { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'] },
))) {
  if (!/^ashlrai\/[a-z0-9][a-z0-9-]*$/.test(repo) || !/^[1-9]\d*$/.test(String(number))) {
    throw new Error('Expected an AshlrAI repository and positive PR number');
  }
  const endpoint = `repos/${repo}/pulls/${number}`;
  // REST mergeable_state can be "unknown" while GitHub computes the merge.
  // Retry on a later supervisor cycle; never infer eligibility from no checks.
  const pr = call(['api', endpoint]);
  if (!eligible(pr, repo) || !(
    (pr.mergeable === false && pr.mergeable_state === 'dirty') ||
    (pr.mergeable === true && pr.mergeable_state === 'behind')
  )) {
    return { status: 'skipped' };
  }
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error('Invalid head SHA');
  if (pr.mergeable === false) return recut(repo, number, pr);
  // expected_head_sha makes a concurrently replaced head fail rather than
  // silently updating a different revision. No force push or admin override.
  try {
    call(['api', '--method', 'PUT', `${endpoint}/update-branch`,
      '-f', `expected_head_sha=${pr.head.sha}`]);
  } catch (error) {
    // A clean/behind observation may become conflicted before PUT. Only a
    // fresh, still-authorized observation of the SAME head permits a handoff.
    // Do not inspect/log credential-bearing provider error strings.
    const fresh = call(['api', endpoint]);
    if (eligible(fresh, repo) && fresh.head.sha === pr.head.sha &&
        fresh.mergeable === false && fresh.mergeable_state === 'dirty') {
      return recut(repo, number, fresh);
    }
    throw error;
  }
  return { status: 'update-requested', headSha: pr.head.sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Expected repository and PR number');
    console.log(JSON.stringify(updateBehind(process.argv[2], process.argv[3])));
  } catch {
    // Provider errors may contain credential-bearing details; keep them out of logs.
    console.error('Bridge update refused or failed; verify Locus identity and PR state');
    process.exitCode = 1;
  }
}
