// Supervisor hook: update one already-authorized bridge PR, then let GitHub CI
// and auto-merge enforce protection. Never resolve conflicts or merge locally.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
  if (pr.state !== 'open' || pr.draft !== false || !pr.auto_merge ||
      pr.base?.repo?.full_name !== repo || pr.head?.repo?.full_name !== repo ||
      pr.base?.ref !== 'master' || !/^codex-bridge\/[A-Za-z0-9_-]+$/.test(pr.head?.ref ?? '') ||
      pr.mergeable !== true || pr.mergeable_state !== 'behind') {
    return { status: 'skipped' };
  }
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error('Invalid head SHA');
  // expected_head_sha makes a concurrently replaced head fail rather than
  // silently updating a different revision. No force push or admin override.
  call(['api', '--method', 'PUT', `${endpoint}/update-branch`,
    '-f', `expected_head_sha=${pr.head.sha}`]);
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
