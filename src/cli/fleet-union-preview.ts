/** Read-only conflict preview. Git objects and scratch files live in a temporary bare repo. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import { FLEET_PR_GH_VIEW_FIELDS, parseFleetPrGhState, type FleetPrGhState } from '../core/fleet/fleet-merge-state.js';
import { classifyDiff3 } from '../core/fleet/dirty-union-preview.js';

const USAGE = 'ashlr fleet union-preview [--json] [--limit N]';
const REPO = 'ashlrai/phantom';
const SHA = /^[0-9a-f]{40}$/;
type Verdict = 'union-safe' | 'needs-model';
type Preview = { number: number; head: string; base: string | null; verdict: Verdict; files: string[]; reason?: string };

async function git(cwd: string, args: string[], maxStdoutBytes = 16 * 1024 * 1024) {
  return defaultGitRunner('git', args, { cwd, timeoutMs: 60_000, maxStdoutBytes });
}

async function inspect(dir: string, pr: FleetPrGhState, remote: string): Promise<Preview> {
  const result: Preview = { number: pr.number, head: pr.headSha, base: null, verdict: 'needs-model', files: [] };
  const fail = (reason: string): Preview => ({ ...result, reason });
  // Fetch only into the disposable repository. A moved head is never classified.
  const baseRef = `refs/heads/${pr.baseRef}`;
  if ((await git(dir, ['check-ref-format', baseRef])).code !== 0) return fail('invalid base ref');
  const fetch = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head',
    remote, `+${baseRef}:refs/preview/base`, `+refs/pull/${pr.number}/head:refs/preview/head`]);
  if (fetch.code !== 0 || fetch.timedOut || fetch.truncated) return fail('fetch failed');
  const head = (await git(dir, ['rev-parse', 'refs/preview/head'])).stdout.trim();
  const base = (await git(dir, ['rev-parse', 'refs/preview/base'])).stdout.trim();
  if (head !== pr.headSha || !SHA.test(base)) return fail('head moved or base unavailable');
  result.base = base;
  const merge = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree', '-z', base, head]);
  if (merge.code !== 1 || merge.timedOut || merge.truncated) return fail('merge-tree did not produce a conflict');
  const parts = merge.stdout.split('\0');
  if (!SHA.test(parts.shift() ?? '')) return fail('invalid merge-tree output');
  const stages = new Map<string, Map<number, { mode: string; oid: string }>>();
  while (parts.length && parts[0] !== '') {
    const entry = parts.shift()!;
    const match = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(entry);
    if (!match) return fail('unreadable conflict entry');
    const mode = match[1], oid = match[2], stage = match[3], path = match[4];
    if (mode == null || oid == null || stage == null || path == null) return fail('unreadable conflict entry');
    const group = stages.get(path) ?? new Map();
    if (group.has(Number(stage))) return fail('duplicate conflict stage');
    group.set(Number(stage), { mode, oid }); stages.set(path, group);
  }
  parts.shift();
  result.files = [...stages.keys()];
  if (!result.files.length) return fail('no conflicting files');
  // Git's structured messages identify non-content conflicts such as renames and binaries.
  while (parts[0]) {
    const count = Number(parts.shift());
    if (!Number.isSafeInteger(count) || count < 1 || parts.length < count + 2) return fail('unreadable conflict message');
    parts.splice(0, count);
    const kind = parts.shift(); parts.shift();
    if (kind !== 'CONFLICT (contents)' && kind !== 'Auto-merging') return fail('non-content conflict');
  }
  for (const group of stages.values()) {
    const entries = [group.get(1), group.get(2), group.get(3)];
    if (entries.some(entry => !entry || !['100644', '100755'].includes(entry.mode)) ||
        entries.some(entry => entry!.mode !== entries[0]!.mode)) return fail('non-text or structural conflict');
    const blobs: string[] = [];
    for (const entry of entries) {
      const blob = await git(dir, ['cat-file', 'blob', entry!.oid], 4 * 1024 * 1024);
      if (blob.code !== 0 || blob.truncated || blob.timedOut || /\0|\ufffd/.test(blob.stdout) ||
          (blob.stdout !== '' && !blob.stdout.endsWith('\n')) || /^(<{7}|\|{7}|={7}|>{7})/m.test(blob.stdout)) return fail('unsupported file content');
      blobs.push(blob.stdout);
    }
    const names = ['base', 'ours', 'theirs'].map(name => join(dir, `preview-${name}`));
    await Promise.all(names.map((name, i) => writeFile(name, blobs[i]!)));
    const merged = await git(dir, ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', names[1]!, names[0]!, names[2]!]);
    if (merged.code === null || merged.code < 1 || merged.code >= 127 || merged.timedOut || merged.truncated || classifyDiff3(merged.stdout) !== 'union-safe') return fail('conflict is not add-only');
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
