import { isAbsolute } from 'node:path';
import { looksLikeOption } from './args.js';
import { takeReview, type ReviewTakeOptions, type ReviewTakeReport } from '../core/fleet/review-take.js';

const USAGE = `Usage: ashlr fleet review-take --agent <name> [--repo <owner/name>] [--ttl-seconds <1-86400>] [--limit <n>] [--root <abs>] [--json]
Pick one unowned review PR and claim it on the coordination ledger.
Defaults: --repo ashlrai/phantom, --ttl-seconds 3600, --limit 100, --root ~/.ashlr-runs.
The claim is advisory: it coordinates agents and grants no merge, push or dispatch authority.
Release: ashlr fleet coordination release <claim-id> --agent <name> --lease <lease>
Keep the lease from stdout for release; do not store it in files, the bus or logs.`;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface FleetReviewTakeDeps extends Partial<Omit<ReviewTakeOptions, 'agent' | 'repo' | 'ttlSeconds' | 'limit'>> {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function textReport(report: ReviewTakeReport): string {
  const { claim, ...fields } = report;
  return [
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value ?? 'none'}`),
    ...(claim === null ? [] : Object.entries(claim).map(([key, value]) => `claim.${key}: ${value}`)),
  ].join('\n') + '\n';
}

export async function cmdFleetReviewTake(args: string[], deps: FleetReviewTakeDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const usage = (message: string): number => { err(`error: ${message}\n${USAGE}\n`); return 2; };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(`${USAGE}\n`); return 0; }
  let agent: string | undefined;
  let repo: string | undefined;
  let ttlSeconds: number | undefined;
  let limit: number | undefined;
  let root = deps.runsDir;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return usage(`repeated argument: ${arg}`);
    seen.add(arg);
    if (arg === '--json') { json = true; continue; }
    if (!['--agent', '--repo', '--ttl-seconds', '--limit', '--root'].includes(arg)) {
      return usage(`invalid fleet review-take argument: ${arg}`);
    }
    const value = args[++i];
    if (value === undefined || looksLikeOption(value)) return usage(`${arg} requires a value`);
    if (arg === '--agent') {
      if (!AGENT_RE.test(value)) return usage('--agent requires a coordination agent name');
      agent = value;
    } else if (arg === '--repo') {
      if (!REPO_RE.test(value)) return usage('--repo requires <owner/name>');
      repo = value;
    } else if (arg === '--root') {
      if (!isAbsolute(value)) return usage('--root requires an absolute path');
      root = value;
    } else {
      const max = arg === '--limit' ? 500 : 86400;
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) return usage(`${arg} requires 1-${max}`);
      if (arg === '--limit') limit = Number(value);
      else ttlSeconds = Number(value);
    }
  }
  if (agent === undefined) return usage('missing --agent <name>');
  const report = await takeReview({ ...deps, agent, repo: repo ?? 'ashlrai/phantom', ttlSeconds, limit, runsDir: root });
  if (report.outcome === 'invalid-input') return usage('invalid coordination claim input');
  out(json ? `${JSON.stringify(report)}\n` : textReport(report));
  return report.outcome === 'claimed' ? 0 : report.outcome === 'none' ? 3 : 1;
}
