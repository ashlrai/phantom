import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertRepo } from '../core/autopilot/github.js';
import { fetchRepo, readCache, summarize, writeCache } from '../core/merge-cockpit.js';
import type { Gh } from '../core/autopilot/github.js';

const USAGE = 'Usage: ashlr fleet pr-cockpit --repo owner/name [--repo owner/name ...] [--json] [--offline] [--refresh]\nRead-only GitHub snapshot. Cached for five minutes; --offline uses the latest cached observations.';
export interface FleetPrCockpitDeps { path?: string; gh?: Gh; now?: () => Date; log?: (text: string) => void; error?: (text: string) => void }
export async function cmdFleetPrCockpit(args: string[], deps: FleetPrCockpitDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { log(USAGE); return 0; }
  const repos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1] && !args[i + 1]!.startsWith('-')) repos.push(args[++i]!);
    else if (!['--json', '--offline', '--refresh'].includes(args[i]!)) { error(USAGE); return 2; }
  }
  if (!repos.length) { error(USAGE); return 2; }
  try { repos.forEach(assertRepo); } catch { error('Invalid repository; expected owner/name.'); return 2; }
  const path = deps.path ?? join(homedir(), '.phantom', 'merge-cockpit.json');
  const now = deps.now?.() ?? new Date();
  const cache = await readCache(path);
  const reports = [];
  let changed = false;
  for (const repo of [...new Set(repos.map(r => r.toLowerCase()))]) {
    const history = cache.snapshots.filter(s => s.repo.toLowerCase() === repo).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let snapshot = history.at(-1);
    let source = snapshot ? (Number.isFinite(Date.parse(snapshot.observedAt)) && now.getTime() - Date.parse(snapshot.observedAt) < 300_000 ? 'cache' : 'stale') : 'unavailable';
    if (!args.includes('--offline') && (args.includes('--refresh') || !snapshot || now.getTime() - Date.parse(snapshot.observedAt) >= 300_000 || !Number.isFinite(Date.parse(snapshot.observedAt)))) {
      try { snapshot = await fetchRepo(repo, deps.gh, now); cache.snapshots.push(snapshot); changed = true; source = 'live'; }
      catch { source = snapshot ? 'stale' : 'unavailable'; }
    }
    reports.push({ repo, source, observedAt: snapshot?.observedAt ?? null, counts: snapshot ? summarize(snapshot) : null,
      history: [...history, ...(source === 'live' && snapshot ? [snapshot] : [])].map(s => ({ observedAt: s.observedAt, open: s.prs.length })) });
  }
  if (changed) {
    // Keep a bounded history per repository, preserving observations for drain trends.
    const byRepo = new Map<string, typeof cache.snapshots>();
    for (const s of cache.snapshots) byRepo.set(s.repo, [...(byRepo.get(s.repo) ?? []), s].slice(-100));
    cache.snapshots = [...byRepo.values()].flat();
    try { await writeCache(path, cache); } catch { /* live results remain useful */ }
  }
  if (args.includes('--json')) log(JSON.stringify({ version: 1, repos: reports }, null, 2));
  else for (const r of reports) {
    log(`\n${r.repo} — ${r.source}${r.observedAt ? ` (${r.observedAt})` : ''}`);
    if (!r.counts) { log('  unavailable'); continue; }
    const c = r.counts;
    log(`  open ${c.open}  conflicting ${c.conflicting}  green ${c.green}  auto-merge ${c.autoMerge}  unknown mergeability ${c.unknownMergeable}  no check rollup ${c.unknownChecks}`);
    if (c.held.length) log(`  held open: ${c.held.map(n => `#${n}`).join(', ')}`);
    for (const e of c.edges) log(`  #${e.rework} ──reworks──> #${e.original}${e.originalHeld ? ' [HELD]' : ''}`);
    if (r.history.length > 1) log(`  open history: ${r.history.map(h => `${h.observedAt}=${h.open}`).join(' → ')}`);
  }
  return reports.some(r => r.source === 'unavailable') ? 1 : 0;
}
