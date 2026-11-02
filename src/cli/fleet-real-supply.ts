/**
 * `ashlr fleet real-supply` — the planner's real work supply, read live.
 *
 * Prints the ranked candidates collectRealSupply reads from the seven
 * approved repos: critical Dependabot alerts, a scheduled suite whose latest
 * run went red, high alerts, then open issues — each with its exact target
 * and a one-line goal. This is the same supply `fleet planner-brief` embeds
 * as its REAL SUPPLY section.
 *
 * READ-ONLY: the only gh calls are `gh api repos/{repo}`,
 * `repos/{repo}/dependabot/alerts`, `repos/{repo}/actions/runs` and
 * `repos/{repo}/issues` GETs — nothing is opened, labeled or closed. The
 * per-repo read is injectable so the report is fully unit-testable; a repo
 * that cannot be read is reported `unknown`, never dropped or faked clean.
 *
 * Exit codes: 0 every repo read, 1 at least one repo unread, 2 bad usage.
 */
import { tmpdir } from 'node:os';

import type { CloudGh } from '../core/cloud/pr-actions.js';
import { collectRealSupply, type RealSupplyDeps, type RealSupplyV1 } from '../core/fleet/planner-real-supply.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import { isTty, makeColors } from './ui.js';

const { bold, dim, red, yellow } = makeColors(isTty());

export const FLEET_REAL_SUPPLY_USAGE = 'ashlr fleet real-supply [--json]';

const GH_TIMEOUT_MS = 15_000;
const GH_API_MAX_BYTES = 4 * 1024 * 1024;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
export const defaultRealSupplyGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes: GH_API_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/** The same read planner-brief embeds; exported so the brief can share it. */
export const readLiveRealSupply = (): Promise<RealSupplyV1> => collectRealSupply({ gh: defaultRealSupplyGh });

export async function cmdFleetRealSupply(args: string[], deps: RealSupplyDeps = {}): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      console.log(`usage: ${FLEET_REAL_SUPPLY_USAGE}`);
      return 0;
    }
    if (arg === '--json' && !json) {
      json = true;
      continue;
    }
    process.stderr.write(red('error: ') + `invalid fleet real-supply argument: ${arg}\nusage: ${FLEET_REAL_SUPPLY_USAGE}\n`);
    return 2;
  }

  const supply = sanitizePublicJson(await collectRealSupply({ ...deps, gh: deps.gh ?? defaultRealSupplyGh })) as RealSupplyV1;
  const unknown = supply.repos.filter(row => row.status === 'unknown').length;

  if (json) {
    console.log(JSON.stringify(supply));
  } else {
    console.log(bold('Fleet real supply:') + ` ${supply.candidates.length} candidate(s), ${supply.repos.length - unknown}/${supply.repos.length} repo(s) read`);
    for (const candidate of supply.candidates) {
      console.log(`  ${candidate.repo.padEnd(28)} ${candidate.kind.padEnd(19)} ${dim(candidate.target)}  ${candidate.goal}`);
    }
    for (const row of supply.repos.filter(repo => repo.status === 'unknown')) {
      console.log(`  ${row.repo.padEnd(28)} ${red('unknown')}  ${dim(row.reason ?? '')}`);
    }
    if (supply.candidates.length === 0 && unknown === 0) console.log('  all repos read clean');
    if (unknown > 0) console.log(yellow(`${unknown} repo(s) could not be read — supply is unread, not empty`));
  }
  return unknown > 0 ? 1 : 0;
}
