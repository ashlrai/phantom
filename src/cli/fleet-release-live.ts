import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../core/fleet/local-store-lock.js';
import { fetchLatestRelease, planReleaseNotices, readReleaseLedger, validReleaseRepo, writeReleaseNotices,
  type ReleaseRunner } from '../core/fleet/release-live-notice.js';

const usage = 'Usage: ashlr fleet release-live [--repo owner/name]... [--dry-run] [--json] [--runs-dir DIR]';
export interface FleetReleaseLiveDeps { run?: ReleaseRunner; runsDir?: string; now?: () => Date; output?: (text: string) => void; error?: (text: string) => void }
export async function cmdFleetReleaseLive(args: string[], deps: FleetReleaseLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  let root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let dryRun = false, json = false;
  const repos: string[] = [], flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (arg !== '--repo' && flags.has(arg)) { error(usage); return 2; }
    flags.add(arg);
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else if ((arg === '--repo' || arg === '--runs-dir') && args[i + 1] && !args[i + 1]!.startsWith('--')) {
      const value = args[++i]!;
      if (arg === '--repo') repos.push(value); else root = value;
    } else { error(usage); return 2; }
  }
  if (!repos.length) repos.push('ashlrai/phantom', 'ashlrai/phantom-secrets');
  if (repos.some(repo => !validReleaseRepo(repo))) { error('fleet release-live: invalid repo'); return 2; }
  const facts = await Promise.all([...new Set(repos)].map(repo => fetchLatestRelease(repo, deps.run)));
  const unreadable = facts.filter(fact => fact === null).length;
  if (unreadable === facts.length) { error('fleet release-live: all repositories unreadable'); return 1; }
  try {
    if (!dryRun) mkdirSync(join(root, 'leader'), { recursive: true, mode: 0o700 });
    const lock = dryRun ? null : acquireLocalStoreLockWithOutcome(join(root, 'leader', 'release-live.lock'));
    if (lock && lock.state !== 'acquired') throw new Error('lock unavailable');
    try {
      const ledger = readReleaseLedger(root);
      const notices = planReleaseNotices(facts, ledger.sent);
      const baselined = !ledger.exists;
      const alreadySent = facts.filter(fact => fact && !fact.draft && ledger.sent.has(`${fact.repo}@${fact.tag}`)).length;
      if (!dryRun) writeReleaseNotices(notices, root, (deps.now ?? (() => new Date()))(), baselined);
      const announced = baselined ? 0 : notices.length;
      if (json) output(JSON.stringify({ announced, alreadySent, unreadable, baselined, dryRun, notices }));
      else {
        if (baselined) output(dryRun ? 'Would baseline current releases.' : 'Baselined current releases.');
        else if (dryRun) for (const notice of notices) output(`Would announce ${notice.repo} ${notice.tag} (${notice.url})`);
        output(`announced ${announced}, already sent ${alreadySent}, unreadable ${unreadable}`);
      }
    } finally { if (lock?.state === 'acquired') releaseLocalStoreLock(lock.lock); }
  } catch { error('fleet release-live: could not read or write notices'); return 1; }
  return 0;
}
