import { resolve } from 'node:path';
import { defaultRuntimeDir, findFleetRepo, fleetDrift, type DriftReport } from '../core/fleet/drift.js';

const usage = 'Usage: phm fleet drift [--json] [--repo <checkout>] [--bin <runtime directory>]';

export interface DriftArgs { json: boolean; repo?: string; bin?: string }

/** Shared by `fleet drift` and `fleet sync`; null means a usage error. */
export function parseDriftArgs(args: string[], extra: string[] = []): (DriftArgs & { flags: string[] }) | null {
  const out: DriftArgs & { flags: string[] } = { json: false, flags: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') out.json = true;
    else if (extra.includes(arg)) out.flags.push(arg);
    else if (arg === '--repo' || arg === '--bin') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return null;
      out[arg === '--repo' ? 'repo' : 'bin'] = resolve(value);
    } else return null;
  }
  return out;
}

/** Load the report both verbs share; prints the reason and returns null when it cannot be built. */
export async function loadDrift(a: DriftArgs, label: string): Promise<DriftReport | null> {
  const repo = a.repo ?? await findFleetRepo();
  if (!repo) { console.error(`${label}: no fleet/manifest.json found; run inside a Phantom checkout or pass --repo`); return null; }
  try { return await fleetDrift(repo, a.bin ?? defaultRuntimeDir()); }
  catch (error) { console.error(`${label}: ${error instanceof Error ? error.message : 'could not read files'}`); return null; }
}

/** Which merged fleet fixes are not live yet. Read-only. */
export async function cmdFleetDrift(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const a = parseDriftArgs(args);
  if (!a) { console.error(usage); return 2; }
  const report = await loadDrift(a, 'fleet drift');
  if (!report) return 1;
  if (a.json) { console.log(JSON.stringify(report)); return 0; }
  const c = report.counts;
  console.log(`Fleet files: ${c.same} live, ${c.repo_newer} not live yet, ${c.missing} missing, ${c.live_only} live only.`);
  for (const f of report.files) {
    if (f.state === 'same') continue;
    const when = f.repoChangedAt ? `repo changed ${f.repoChangedAt.slice(0, 10)}` : 'repo change date unknown';
    console.log(`  ${f.state.padEnd(10)} ${f.file}  (${when}${f.protectedReason ? `; protected: ${f.protectedReason}` : ''})`);
  }
  if (report.notLive > 0) console.log('Next: phm fleet sync --dry-run');
  return 0;
}
