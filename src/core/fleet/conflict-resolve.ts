/**
 * core/fleet/conflict-resolve.ts: mechanical merge-conflict resolution
 * (RQ-MERGE-THROUGHPUT-2 item d).
 *
 * A DIRTY bridge PR usually conflicts on files no model should have to read:
 * lockfiles, generated docs and the changelog. This module classifies each
 * conflicted path and resolves the mechanical ones; any path it cannot prove
 * mechanical stays a REAL conflict and the whole PR falls back to a
 * conflict-resolution lane (`RQ-DRAIN-<repo>-<n>-<head7>`, which dispatchd's
 * DEDUPE-OPEN-PR never confuses with the PR's own bridge head key).
 *
 * STRATEGIES
 *   union       append-only text (CHANGELOG.md): keep both sides of every
 *               hunk, duplicate lines dropped. Deletions cannot be proven
 *               absent without a base, so a hunk where one side is empty is
 *               still kept (an addition on the other side).
 *   regenerate  lockfiles and generated docs: take the base copy (master; git's "theirs" when merging into the PR head)
 *               copy, re-run the owning generator once, stage the result.
 *               The generator is injected; a missing or failing generator
 *               makes the path real, never a guess.
 *
 * SAFE BY CONSTRUCTION. Security-pinned paths (.github, dispatchd, scrub,
 * reap, publish.sh) are never mechanical. The executor merges the base INTO
 * the PR head in a throwaway worktree (a merge commit: no rewrite, no force
 * push) and returns the new commit; pushing is the host's job. On any doubt
 * the merge is aborted and the PR is left untouched.
 */
import { securityPinnedPath } from '../drive/refix-loop.js';

export type ConflictKind = 'lockfile' | 'generated' | 'changelog' | 'real';
export type ConflictStrategy = 'union' | 'regenerate';

export interface ConflictClass {
  path: string;
  kind: ConflictKind;
  strategy: ConflictStrategy | null;
  /** Generator command argv for `regenerate`; null when none applies. */
  generator: readonly string[] | null;
}

const LOCKFILES: Record<string, readonly string[]> = {
  'package-lock.json': ['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
  'pnpm-lock.yaml': ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'],
};

/** Generated files and the repo script that rewrites them. */
const GENERATED: Record<string, readonly string[]> = {
  'docs/llms.txt': ['node', 'scripts/generate-docs-llms.mjs'],
  'llms.txt': ['node', 'scripts/generate-site-llms.mjs'],
};

const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '');

export function classifyConflictPath(rawPath: string): ConflictClass {
  const path = normalize(rawPath);
  const real: ConflictClass = { path, kind: 'real', strategy: null, generator: null };
  if (!path || path.startsWith('/') || path.split('/').includes('..') || securityPinnedPath(path)) return real;
  const base = path.split('/').pop() ?? path;
  // Only the repo-root lockfile is regenerated; nested lockfiles belong to
  // sub-packages whose install context we do not know.
  if (path === base && LOCKFILES[base]) {
    return { path, kind: 'lockfile', strategy: 'regenerate', generator: LOCKFILES[base]! };
  }
  if (GENERATED[path]) return { path, kind: 'generated', strategy: 'regenerate', generator: GENERATED[path]! };
  if (path === 'CHANGELOG.md') return { path, kind: 'changelog', strategy: 'union', generator: null };
  return real;
}

export interface MechanicalPlan {
  verdict: 'none' | 'mechanical' | 'real';
  mechanical: ConflictClass[];
  real: ConflictClass[];
}

/** One real path makes the verdict `real`: a half-resolved PR still needs the agent. */
export function planMechanicalResolution(paths: readonly string[]): MechanicalPlan {
  const classes = [...new Set(paths.map(normalize))].sort().map(classifyConflictPath);
  const mechanical = classes.filter((c) => c.kind !== 'real');
  const real = classes.filter((c) => c.kind === 'real');
  const verdict = classes.length === 0 ? 'none' : real.length > 0 ? 'real' : 'mechanical';
  return { verdict, mechanical, real };
}

const OURS = /^<{7}(?: .*)?$/;
const MID = /^={7}$/;
const THEIRS = /^>{7}(?: .*)?$/;
const BASE_MARK = /^\|{7}(?: .*)?$/;

export type UnionResult = { ok: true; text: string; hunks: number } | { ok: false; reason: string };

/**
 * Resolve every conflict hunk of an append-only file by keeping both sides.
 * diff3 base sections and malformed markers fail closed.
 */
export function unionResolve(text: string): UnionResult {
  const lines = text.split('\n');
  const out: string[] = [];
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!OURS.test(line)) {
      if (MID.test(line) || THEIRS.test(line) || BASE_MARK.test(line)) return { ok: false, reason: 'stray-marker' };
      out.push(line);
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    let side = ours;
    let closed = false;
    for (i++; i < lines.length; i++) {
      const inner = lines[i]!;
      if (BASE_MARK.test(inner) || OURS.test(inner)) return { ok: false, reason: 'diff3-or-nested' };
      if (MID.test(inner)) {
        if (side === theirs) return { ok: false, reason: 'malformed' };
        side = theirs;
      } else if (THEIRS.test(inner)) {
        closed = true;
        break;
      } else {
        side.push(inner);
      }
    }
    if (!closed || side !== theirs) return { ok: false, reason: 'unterminated' };
    hunks++;
    const seen = new Set<string>();
    for (const l of [...ours, ...theirs]) {
      // Blank separator lines repeat legitimately; only content lines dedupe.
      if (l.trim() !== '' && seen.has(l)) continue;
      seen.add(l);
      out.push(l);
    }
  }
  return { ok: true, text: out.join('\n'), hunks };
}

// ---------------------------------------------------------------------------
// Executor: injected git/generator, throwaway worktree owned by the caller.
// ---------------------------------------------------------------------------

export interface ConflictResolveIo {
  /** Run git in the worktree; resolves stdout, rejects on non-zero unless `allowFail`. */
  git(args: string[], opts?: { allowFail?: boolean }): Promise<{ code: number; stdout: string }>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** Run a generator argv in the worktree; true on exit 0. */
  run(argv: readonly string[]): Promise<boolean>;
}

export type ResolveOutcome =
  | { status: 'clean-merge'; commit: string }
  | { status: 'resolved'; commit: string; resolved: string[] }
  | { status: 'real'; real: string[]; mechanical: string[] }
  | { status: 'failed'; reason: string };

/**
 * Merge `baseRef` into the checked-out PR head. The worktree must be a clean
 * checkout of the PR head. Never rewrites history: success is one merge commit
 * on top of the head. On `real`/`failed` the merge is aborted.
 */
export async function resolveMechanically(io: ConflictResolveIo, baseRef: string): Promise<ResolveOutcome> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseRef) || baseRef.startsWith('-')) return { status: 'failed', reason: 'bad-base-ref' };
  const abort = async (): Promise<void> => { await io.git(['merge', '--abort'], { allowFail: true }); };
  try {
    const merged = await io.git(['merge', '--no-ff', '--no-edit', '--no-verify', baseRef], { allowFail: true });
    if (merged.code === 0) {
      return { status: 'clean-merge', commit: (await io.git(['rev-parse', 'HEAD'])).stdout.trim() };
    }
    const listed = await io.git(['diff', '--name-only', '--diff-filter=U']);
    const paths = listed.stdout.split('\n').map((p) => p.trim()).filter(Boolean);
    const plan = planMechanicalResolution(paths);
    if (plan.verdict !== 'mechanical') {
      await abort();
      return plan.verdict === 'none'
        ? { status: 'failed', reason: 'merge-failed-without-conflicts' }
        : { status: 'real', real: plan.real.map((c) => c.path), mechanical: plan.mechanical.map((c) => c.path) };
    }
    const generators = new Map<string, readonly string[]>();
    for (const c of plan.mechanical) {
      if (c.strategy === 'union') {
        const result = unionResolve(await io.read(c.path));
        if (!result.ok) { await abort(); return { status: 'real', real: [c.path], mechanical: [] }; }
        await io.write(c.path, result.text);
      } else {
        // Start from the base copy so the generator sees no markers.
        await io.git(['checkout', '--theirs', '--', c.path]);
        generators.set(c.generator!.join('\0'), c.generator!);
      }
    }
    for (const argv of generators.values()) {
      if (!(await io.run(argv))) { await abort(); return { status: 'real', real: plan.mechanical.map((c) => c.path), mechanical: [] }; }
    }
    await io.git(['add', '--', ...plan.mechanical.map((c) => c.path)]);
    const left = await io.git(['diff', '--name-only', '--diff-filter=U']);
    if (left.stdout.trim()) { await abort(); return { status: 'failed', reason: 'unresolved-after-resolution' }; }
    await io.git(['commit', '--no-edit', '--no-verify']);
    return {
      status: 'resolved',
      commit: (await io.git(['rev-parse', 'HEAD'])).stdout.trim(),
      resolved: plan.mechanical.map((c) => c.path),
    };
  } catch {
    await abort();
    return { status: 'failed', reason: 'git-error' };
  }
}
