import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet repo-rate [--hours 6] [--target 20] [--all] [--json]';
export interface FleetRepoRateDependencies {
  read: (path: string) => Promise<string>;
  now: () => number;
}

/**
 * Count each PR once using its newest outcome in the inclusive window.
 * Accepts ISO-8601 timestamps ending with Z, ±HH:MM, or ±HHMM offsets.
 * For ±HHMM (no colon), a colon is inserted before Date.parse so
 * the built-in parser handles it correctly.
 */
export function fleetRepoRate(text: string, hours: number, target: number, all: boolean, now: number) {
  const merges = new Map<string, { repo: string; at: number; ttm: number | null }>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      if (row.event !== 'outcome' || row.state !== 'MERGED') continue;
      const raw = typeof row.ts === 'string' ? row.ts : '';
      const z = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw);
      const om = /(?:Z|[+-]\d{4})$/.test(raw);
      const ts = (z || om) ? (row.ts as string).replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3') : '';
      const at = (z || om) ? Date.parse(ts) : NaN;
      const match = typeof row.url === 'string'
        ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(row.url) : null;
      if (!Number.isFinite(at) || !match) throw new Error();
      if (at < now - hours * 3_600_000 || at > now) continue;
      const repo = match[1]!.toLowerCase(), key = `${repo}/${match[2]}`;
      const ttm = typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0 ? row.ttm_s : null;
      if (!merges.has(key) || merges.get(key)!.at <= at) merges.set(key, { repo, at, ttm });
    } catch { ignored++; }
  }
  const groups = new Map<string, { at: number; ttm: number | null }[]>([['ashlrai/phantom', []]]);
  for (const entry of merges.values()) {
    const rows = groups.get(entry.repo) ?? [];
    rows.push(entry); groups.set(entry.repo, rows);
  }
  const by_repo = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([repo, rows]) => {
    const times = rows.flatMap(row => row.ttm === null ? [] : [row.ttm]).sort((a, b) => a - b);
    const n = times.length, checked = all || repo === 'ashlrai/phantom';
    return { repo, merged: rows.length,
      median_ttm_s: n ? times[Math.floor((n - 1) / 2)]! / 2 + times[Math.floor(n / 2)]! / 2 : null,
      newest_merge_at: rows.length ? new Date(rows.reduce((max, row) => Math.max(max, row.at), -Infinity)).toISOString() : null,
      checked, red: checked && rows.length < target };
  });
  return { schema: 'fleet.repo-rate.v1', hours, target, all, by_repo, red: by_repo.some(row => row.red), ignored_rows: ignored };
}

export async function cmdFleetRepoRate(args: string[], deps: FleetRepoRateDependencies = {
  read: path => readFile(path, 'utf8'), now: Date.now,
}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead merged PRs from ~/.ashlr-runs/metrics/jobs.jsonl. Exit 1 below target; checks Phantom by default, or every observed repo with --all. Missing merge times and medians are unknown.`);
    return 0;
  }
  let hours = 6, target = 20, all = false, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { console.error(usage); return 2; }
    seen.add(flag);
    if (flag === '--json') json = true;
    else if (flag === '--all') all = true;
    else if (flag === '--hours' || flag === '--target') {
      const raw = args[++i], value = Number(raw);
      if (!raw?.trim() || !Number.isFinite(value) || value < 0
        || (flag === '--hours' ? value === 0 || !Number.isFinite(value * 3_600_000) : !Number.isSafeInteger(value))) {
        console.error(usage); return 2;
      }
      if (flag === '--hours') hours = value; else target = value;
    } else { console.error(usage); return 2; }
  }
  try {
    const report = fleetRepoRate(await deps.read(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')), hours, target, all, deps.now());
    console.log(json ? JSON.stringify(report) : [
      `Repo merge rate (last ${hours} hours, target ${target})`,
      ...report.by_repo.map(row => `${row.repo}: ${row.merged} merged, median ${row.median_ttm_s ?? 'unknown'} seconds, newest ${row.newest_merge_at ?? 'unknown'}${row.red ? ' — RED' : ''}`),
    ].join('\n'));
    return report.red ? 1 : 0;
  } catch { console.error('Unable to read jobs ledger.'); return 1; }
}
