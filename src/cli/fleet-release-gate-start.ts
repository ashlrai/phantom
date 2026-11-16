import { startReleaseGate } from '../core/fleet/release-gate-start.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-gate-start --repo OWNER/REPO --sha FULLSHA [--apply] --json';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export async function cmdFleetReleaseGateStart(args: string[], deps: { gh?: GitRunner } = {}): Promise<number> {
  const values = new Map<string, string>();
  let apply = false; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(`${USAGE}\n\nDry run by default. --apply submits ci.yml with release_gate=true after refreshing the default branch head and run inventory. Branch movement can still race dispatch: check the actual run head and inspect the release candidate before downstream reuse. Submission is not publication, attestation, or installation.`);
      return 0;
    }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--repo', '--sha'].includes(arg) || values.has(arg) || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
    }
    values.set(arg, args[++i]!);
  }
  const repo = values.get('--repo') ?? ''; const sha = values.get('--sha') ?? '';
  if (!json || !REPO.test(repo) || repo.split('/')[0]!.endsWith('-') || repo.split('/')[0]!.includes('--')
    || repo.endsWith('/.') || repo.endsWith('/..') || !/^[a-f0-9]{40}$/.test(sha)) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  const report = await startReleaseGate(repo, sha, { apply, runner: deps.gh });
  console.log(JSON.stringify(report));
  return report.outcome === 'unavailable' ? 3 : report.outcome === 'refused' ? 1 : 0;
}
