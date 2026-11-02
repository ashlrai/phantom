/**
 * `ashlr fleet union-apply --pr N --out <dir>` — the write side of the union
 * preview. For one open DIRTY PR it re-runs the preview's isolated fetch +
 * merge-tree pipeline, mechanically resolves every file whose conflict hunks
 * are all union-safe, and writes the resolved files (at their repo-relative
 * paths) plus a unified `union-apply.patch` into a directory the caller
 * names — so a recut is `git apply`, not another merge.
 *
 * NEVER pushes, never touches a branch, and never writes inside a repository
 * working tree: git objects live in a temporary bare repo and output lands
 * only under --out, with no clobbering. A PR with any needs-model hunk
 * writes nothing and exits nonzero with the reason.
 * Exit codes: 0 written, 1 refused/failed, 2 bad usage.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';
import { FLEET_PR_GH_VIEW_FIELDS, parseFleetPrGhState } from '../core/fleet/fleet-merge-state.js';
import { classifyDiff3 } from '../core/fleet/dirty-union-preview.js';
import { collectPrConflicts } from '../core/fleet/dirty-union-collect.js';
import { resolveUnionMerge } from '../core/fleet/dirty-union-apply.js';

const USAGE = 'ashlr fleet union-apply --pr N --out <dir> [--json]';
const REPO = 'ashlrai/phantom';
const PATCH_NAME = 'union-apply.patch';

async function git(cwd: string, args: string[], maxStdoutBytes = 16 * 1024 * 1024) {
  return defaultGitRunner('git', args, { cwd, timeoutMs: 60_000, maxStdoutBytes });
}

/** Repo-relative conflict path → safe output segments, or null when it could escape the out dir. */
function safePath(path: string): string[] | null {
  const segs = path.split('/');
  const clean = [...path].every(ch => ch >= ' ' && ch !== '\x7f');
  return clean && segs.every(seg => seg !== '' && seg !== '.' && seg !== '..') ? segs : null;
}

/** The nearest existing ancestor directory of `path`, or null at the filesystem root. */
async function existingAncestor(path: string): Promise<string | null> {
  let dir = resolve(path);
  for (;;) {
    const info = await stat(dir).catch(() => null);
    if (info?.isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function cmdFleetUnionApply(args: string[], deps: { gh?: CloudGh; remote?: string } = {}): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { console.log(`Usage: ${USAGE}`); return 0; }
  let pr: number | null = null, out: string | null = null, json = false, seenPr = false, seenOut = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--pr' && !seenPr && /^\d+$/.test(args[i + 1] ?? '')) {
      pr = Number(args[++i]); seenPr = true;
      if (!Number.isSafeInteger(pr) || pr < 1) { console.error(`Invalid PR number. Usage: ${USAGE}`); return 2; }
    } else if (args[i] === '--out' && !seenOut && typeof args[i + 1] === 'string' && args[i + 1] !== '' && !args[i + 1]!.startsWith('--')) {
      out = args[++i]; seenOut = true;
    } else { console.error(`Invalid argument. Usage: ${USAGE}`); return 2; }
  }
  if (pr === null || out === null) { console.error(`Missing --pr or --out. Usage: ${USAGE}`); return 2; }
  const prNumber = pr, outDir = resolve(out);
  const fail = (reason: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, pr: prNumber, reason }));
    else console.error(`fleet union-apply: ${reason}`);
    return 1;
  };

  const gh: CloudGh = deps.gh ?? (async argv => {
    const r = await defaultGitRunner('gh', argv, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
    return { ok: r.code === 0 && !r.truncated && !r.timedOut, stdout: r.stdout, stderr: r.stderr };
  });
  const read = await gh(['pr', 'view', String(prNumber), '--repo', REPO, '--json', FLEET_PR_GH_VIEW_FIELDS]);
  if (!read.ok) return fail('gh pr view failed');
  let row: unknown;
  try { row = JSON.parse(read.stdout); } catch { return fail('invalid gh response'); }
  const state = parseFleetPrGhState(row);
  if (state === null || state.state !== 'OPEN' || state.mergeStateStatus !== 'DIRTY') return fail('not a dirty open PR');

  // Output must never land in a repository working tree — check the nearest
  // existing ancestor before --out is even created.
  const ancestor = await existingAncestor(outDir);
  if (ancestor !== null && (await git(ancestor, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true') {
    return fail('out dir is inside a git working tree');
  }

  const root = await mkdtemp(join(tmpdir(), 'fleet-union-apply-'));
  try {
    const dir = join(root, 'repo');
    await mkdir(dir, { recursive: true });
    const init = await git(dir, ['init', '--bare', '--quiet']);
    if (init.code !== 0) return fail('could not initialize temporary object store');
    // Override repository attributes: GitHub does not honor merge=union.
    await writeFile(join(dir, 'info', 'attributes'), '* merge\n');
    const found = await collectPrConflicts(dir, state, deps.remote ?? 'https://github.com/ashlrai/phantom.git');
    if (!found.ok) return fail(found.reason);

    // Everything resolves in memory first: a needs-model hunk writes nothing.
    const resolved: { path: string; segs: string[]; mode: string; text: string }[] = [];
    for (const file of found.files) {
      if (classifyDiff3(file.diff3) !== 'union-safe') return fail(`${file.path}: conflict is not add-only`);
      const merged = resolveUnionMerge(file.base, file.ours, file.theirs);
      if (!merged.ok) return fail(`${file.path}: ${merged.reason}`);
      const segs = safePath(file.path);
      if (segs === null) return fail(`unsafe path ${JSON.stringify(file.path)}`);
      resolved.push({ path: file.path, segs, mode: file.mode, text: merged.text });
    }

    // The patch replays base-tip→resolved: stage each resolved blob over the
    // base tree in the disposable repo's index so `diff --cached` emits real
    // a/<path>/b/<path> headers — `git apply` on the base branch reproduces
    // the resolved conflict files exactly.
    if ((await git(dir, ['read-tree', 'refs/preview/base'])).code !== 0) return fail('patch generation failed');
    for (const [i, file] of resolved.entries()) {
      const scratch = join(root, `resolved-${i}`);
      await writeFile(scratch, file.text);
      const hash = await git(dir, ['hash-object', '-w', scratch]);
      const blob = hash.stdout.trim();
      if (hash.code !== 0 || !/^[0-9a-f]{40}$/.test(blob) ||
          (await git(dir, ['update-index', '--add', '--cacheinfo', `${file.mode},${blob},${file.path}`])).code !== 0) {
        return fail('patch generation failed');
      }
    }
    const diff = await git(dir, ['diff', '--cached', 'refs/preview/base']);
    if (diff.code !== 0 || diff.timedOut || diff.truncated) return fail('patch generation failed');

    await mkdir(outDir, { recursive: true });
    try {
      for (const file of resolved) {
        const target = join(outDir, ...file.segs);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.text, { flag: 'wx' });
      }
      await writeFile(join(outDir, PATCH_NAME), diff.stdout, { flag: 'wx' });
    } catch {
      return fail('output already exists or is not writable');
    }
    const files = resolved.map(file => file.path);
    if (json) console.log(JSON.stringify({ ok: true, pr: prNumber, out: outDir, files, patch: PATCH_NAME }));
    else {
      console.log(`fleet union-apply: PR #${prNumber} — ${files.length} file(s) resolved into ${outDir}`);
      for (const file of files) console.log(`  ${file}`);
      console.log(`  ${PATCH_NAME}`);
    }
    return 0;
  } finally { await rm(root, { recursive: true, force: true }); }
}
