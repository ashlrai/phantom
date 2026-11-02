/** Read-only conflict preview. Git objects and scratch files live in a temporary bare repo. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import { FLEET_PR_GH_VIEW_FIELDS, parseFleetPrGhState, type FleetPrGhState } from '../core/fleet/fleet-merge-state.js';
import { classifyDiff3 } from '../core/fleet/dirty-union-preview.js';
import { collectPrConflicts } from '../core/fleet/dirty-union-collect.js';

const USAGE = 'ashlr fleet union-preview [--json] [--limit N]';
const REPO = 'ashlrai/phantom';
type Verdict = 'union-safe' | 'needs-model';
type Preview = { number: number; head: string; base: string | null; verdict: Verdict; files: string[]; reason?: string };

export { parseConflictEntry } from '../core/fleet/dirty-union-collect.js';

async function git(cwd: string, args: string[], maxStdoutBytes = 16 * 1024 * 1024) {
  return defaultGitRunner('git', args, { cwd, timeoutMs: 60_000, maxStdoutBytes });
}

async function inspect(dir: string, pr: FleetPrGhState, remote: string): Promise<Preview> {
  const result: Preview = { number: pr.number, head: pr.headSha, base: null, verdict: 'needs-model', files: [] };
  const found = await collectPrConflicts(dir, pr, remote);
  if (!found.ok) return { ...result, files: found.files ?? [], reason: found.reason };
  result.base = found.base;
  result.files = found.files.map(file => file.path);
  for (const file of found.files) {
    if (classifyDiff3(file.diff3) !== 'union-safe') return { ...result, reason: 'conflict is not add-only' };
  }
  result.verdict = 'union-safe';
  return result;
}

export async function cmdFleetUnionPreview(args: string[], deps: { gh?: CloudGh; remote?: string } = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(`Usage: ${USAGE}`); return 0; }
  let limit = 500, json = false, seenLimit = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--limit' && !seenLimit && /^\d+$/.test(args[i + 1] ?? '')) {
      limit = Number(args[++i]); seenLimit = true;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) { console.error(`Invalid limit. Usage: ${USAGE}`); return 2; }
    } else { console.error(`Invalid argument. Usage: ${USAGE}`); return 2; }
  }
  const gh: CloudGh = deps.gh ?? (async argv => {
    const r = await defaultGitRunner('gh', argv, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
    return { ok: r.code === 0 && !r.truncated && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
  });
  const read = await gh(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', String(limit), '--json', FLEET_PR_GH_VIEW_FIELDS]);
  if (!read.ok) { console.error('fleet union-preview: gh pr list failed'); return 1; }
  let rows: unknown;
  try { rows = JSON.parse(read.stdout); } catch { console.error('fleet union-preview: invalid gh response'); return 1; }
  if (!Array.isArray(rows)) { console.error('fleet union-preview: invalid gh response'); return 1; }
  const prs = rows.map(parseFleetPrGhState);
  if (prs.some(pr => pr === null)) { console.error('fleet union-preview: unreadable PR row'); return 1; }
  const dirty = prs.filter((pr): pr is FleetPrGhState => pr !== null && pr.state === 'OPEN' && pr.mergeStateStatus === 'DIRTY');
  const dir = await mkdtemp(join(tmpdir(), 'fleet-union-preview-'));
  try {
    const init = await git(dir, ['init', '--bare', '--quiet']);
    if (init.code !== 0) { console.error('fleet union-preview: could not initialize temporary object store'); return 1; }
    // Override repository attributes: GitHub does not honor merge=union.
    await writeFile(join(dir, 'info', 'attributes'), '* merge\n');
    const previews: Preview[] = [];
    for (const pr of dirty) {
      try { previews.push(await inspect(dir, pr, deps.remote ?? 'https://github.com/ashlrai/phantom.git')); }
      catch { previews.push({ number: pr.number, head: pr.headSha, base: null, verdict: 'needs-model', files: [], reason: 'inspection failed' }); }
    }
    const safe = previews.filter(pr => pr.verdict === 'union-safe').length;
    const report = { repo: REPO, open: rows.length, complete: rows.length < limit, dirty: dirty.length,
      counts: { 'union-safe': safe, 'needs-model': dirty.length - safe }, prs: previews };
    if (json) console.log(JSON.stringify(report));
    else {
      console.log(`Fleet union preview (${REPO}): ${dirty.length} DIRTY, ${safe} union-safe, ${dirty.length - safe} needs-model${report.complete ? '' : ' (page limit reached)'}`);
      for (const pr of previews) console.log(`#${pr.number} ${pr.verdict}: ${pr.files.map(file => JSON.stringify(file)).join(', ') || '(files unavailable)'}${pr.reason ? ` — ${pr.reason}` : ''}`);
    }
    return 0;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
