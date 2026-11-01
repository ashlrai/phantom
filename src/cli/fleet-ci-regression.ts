import { tmpdir } from 'node:os';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { ciRegression } from '../core/fleet/ci-regression.js';

const usage = 'ashlr fleet ci-regression --repo <owner/name> --run <id> [--json]';
const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

export async function cmdFleetCiRegression(args: string[], deps: { gh?: CloudGh } = {}): Promise<number> {
  let repo = '', run = '', json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && !repo) repo = args[++i] ?? '';
    else if (args[i] === '--run' && !run) run = args[++i] ?? '';
    else if (args[i] === '--json' && !json) json = true;
    else { process.stderr.write(`Invalid argument. Usage: ${usage}\n`); return 2; }
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo) ||
      !/^[1-9]\d*$/.test(run) || !Number.isSafeInteger(Number(run))) {
    process.stderr.write(`Invalid repository or run id. Usage: ${usage}\n`); return 2;
  }
  try {
    const result = await ciRegression(repo, Number(run), deps.gh ?? defaultGh);
    if (json) console.log(JSON.stringify(result));
    else {
      console.log(`CI regression ${repo}: target #${result.target.id} (${result.target.head_sha}); ` +
        (result.baseline ? `baseline #${result.baseline.id} (${result.baseline.head_sha})` : 'no baseline') + ` — ${result.status}`);
      const c = result.comparison;
      if (c) {
        console.log(`Newly failing jobs: ${c.newlyFailingJobs.join(', ') || 'none'}`);
        console.log(`Newly failing steps: ${c.newlyFailingSteps.map(s => `${s.job} / ${s.step}`).join(', ') || 'none'}`);
        console.log(`New jobs: ${c.newJobs.join(', ') || 'none'}; missing jobs: ${c.missingJobs.join(', ') || 'none'}`);
        console.log(`Ambiguous matches: ${c.ambiguous.length}; unknown comparisons: ${c.unknown.length}. Inspect JSON for details.`);
      } else console.log('Comparison unavailable; inspect the source status before acting.');
    }
    return 0;
  } catch (error) {
    const known = ['GitHub read failed', 'invalid GitHub response', 'target run id mismatch', 'target run is not scheduled'];
    const message = error instanceof Error && known.includes(error.message) ? error.message : 'GitHub read failed';
    if (json) console.log(JSON.stringify({ v: 1, repo, status: 'unknown', error: message }));
    else process.stderr.write(`CI regression: ${message}\n`);
    return 1;
  }
}
