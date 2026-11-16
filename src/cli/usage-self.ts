import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSelfRefresh } from '../core/fabric/lane-usage-self-io.js';
import { SELF_LANES, type SelfLane } from '../core/fabric/lane-usage-self.js';

/**
 * One-shot lane usage refresh for launchd or the bridge: reads each lane's sanctioned source,
 * falls back to an estimate, and rewrites the budget fields in queue/budget-overrides.json.
 * No watcher or timer; the caller schedules it (contrib/mac/com.ashlr.usage-self.plist.in).
 */
export async function runUsageSelf(argv: string[]): Promise<string> {
  let runsDir = process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  let codexHome: string | undefined; let dryRun = false; const lanes: SelfLane[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--runs-dir' && argv[i + 1]) runsDir = argv[++i]!;
    else if (a === '--codex-home' && argv[i + 1]) codexHome = argv[++i]!;
    else if (a === '--lane' && SELF_LANES.includes(argv[i + 1] as SelfLane)) lanes.push(argv[++i] as SelfLane);
    else throw new Error('Usage: [--runs-dir ABS_PATH] [--codex-home ABS_PATH] [--lane LANE]... [--dry-run]');
  }
  if (!isAbsolute(runsDir) || codexHome !== undefined && !isAbsolute(codexHome)) throw new Error('Paths must be absolute');
  if (codexHome && /(?:^|\/)\.codex[^/]*(?:\/|$)/.test(resolve(codexHome))) throw new Error('A ~/.codex* path is never read');
  const r = await runSelfRefresh({ runsDir, nowMs: Date.now, dryRun, ...(codexHome ? { codexHome } : {}), ...(lanes.length ? { lanes } : {}) });
  return JSON.stringify({ dryRun, lanes: r.outcomes.map(o => ({ lane: o.lane, action: o.action,
    weekly_used_pct: o.entry?.weekly_used_pct ?? null, reset_at: o.entry?.reset_at ?? null,
    estimated: o.entry?.estimated ?? null, source: o.entry?.source ?? null })) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUsageSelf(process.argv.slice(2)).then(s => console.log(s), (e: Error) => {
    console.error(e.message); process.exitCode = 1;
  });
}
