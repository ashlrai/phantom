import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet checks-red [--hours 6] [--json]';
export interface FleetChecksRedDependencies {
  read: (path: string) => Promise<string>;
  now: () => number;
}

/** Count each PR once, using its newest merged outcome in the window.
 * Red evidence is checks="red" or checks_red=true; missing checks are unknown. */
export function fleetChecksRed(text: string, hours: number, now: number) {
  const merges = new Map<string, { repo: string; at: number; red: boolean; unknown: boolean }>();
  let ignored = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      const row = value as Record<string, unknown>;
      if (row.event !== 'outcome' || row.state !== 'MERGED') continue;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      const match = typeof row.url === 'string'
        ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(row.url) : null;
      if (!Number.isFinite(at) || !match) throw new Error();
      if (at < now - hours * 3_600_000 || at > now) continue;
      const repo = match[1]!.toLowerCase(), url = `https://github.com/${repo}/pull/${match[2]}`;
      if (!merges.has(url) || merges.get(url)!.at <= at) merges.set(url, {
        repo, at, red: row.checks === 'red' || row.checks_red === true,
        unknown: !['red', 'green'].includes(String(row.checks)) && typeof row.checks_red !== 'boolean',
      });
    } catch { ignored++; }
  }
  const groups = new Map<string, { url: string; at: number; red: boolean; unknown: boolean }[]>();
  for (const [url, entry] of merges) {
    const rows = groups.get(entry.repo) ?? [];
    rows.push({ url, ...entry }); groups.set(entry.repo, rows);
  }
  const by_repo = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([repo, rows]) => {
    const red = rows.filter(row => row.red).sort((a, b) => b.at - a.at || a.url.localeCompare(b.url));
    const red_share = red.length / rows.length;
    return { repo, merged: rows.length, merged_with_checks_red: red.length, red_share,
      checks_unknown: rows.filter(row => row.unknown).length,
      newest_red_pr_urls: red.slice(0, 3).map(row => row.url), red: rows.length >= 5 && red_share > 0.5 };
  });
  return { schema: 'fleet.checks-red.v1', hours, by_repo, red: by_repo.some(row => row.red), ignored_rows: ignored };
}

export async function cmdFleetChecksRed(args: string[], deps: FleetChecksRedDependencies = {
  read: path => readFile(path, 'utf8'), now: Date.now,
}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead merged PR outcomes from ~/.ashlr-runs/metrics/jobs.jsonl. Red means checks="red" or checks_red=true. Missing checks stay unknown. Exit 1 when a repo has at least 5 merges and more than half have red checks.`);
    return 0;
  }
  let hours = 6, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours && args[i + 1]?.trim()
      && Number.isFinite(Number(args[i + 1])) && Number(args[i + 1]) > 0
      && Number.isFinite(Number(args[i + 1]) * 3_600_000)) {
      hours = Number(args[++i]); seenHours = true;
    } else { console.error(usage); return 2; }
  }
  try {
    const report = fleetChecksRed(await deps.read(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')), hours, deps.now());
    console.log(json ? JSON.stringify(report) : [
      `Merged PR checks (last ${hours} hours)`,
      ...report.by_repo.map(row => `${row.repo}: ${row.merged} merged, ${row.merged_with_checks_red} with red checks (${(row.red_share * 100).toFixed(1)}%), ${row.checks_unknown} unknown${row.red ? ' — RED' : ''}\n${row.newest_red_pr_urls.join('\n')}`),
      ...(report.by_repo.length ? [] : ['No merged PRs in this window.']),
    ].join('\n'));
    return report.red ? 1 : 0;
  } catch { console.error('Unable to read jobs ledger.'); return 1; }
}
