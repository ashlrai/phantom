/**
 * Collision-free fleet edits (VISION collision-free-prs).
 *
 * Concurrent fleet PRs collide on the same few singleton files: every job's
 * changelog entry lands on CHANGELOG's top section, CLAUDE.md and README
 * attract the same summary rewrites, and lockfiles regenerate to different
 * bytes under every install. Two independently correct PRs then conflict at
 * merge time and the later one dies on a rebase rather than on review.
 *
 * The bridge therefore refuses any fleet edit set that touches:
 *
 *   - `CHANGELOG` (.md/.rst/.txt/…)  — but the intent is not dropped: when the
 *     caller supplies the fragment it wants published, the changelog edit is
 *     diverted to `changelog.d/<job>.<kind>.md`. Fragments are additive and
 *     uniquely named per job, so any number of concurrent PRs merge clean;
 *   - `CLAUDE.md`                     — agent instructions are owner-edited;
 *   - `README` (.md/.rst/…)           — the project front page is owner-edited;
 *   - dependency lockfiles            — generated files that are the single
 *                                       most common merge-collision source.
 *
 * This is an ADMISSION rule for a PR's file list, separate from the merge
 * gate's owner lane (authority/protected-paths.ts): a refused edit never
 * produces a commit, so there is nothing left to lane. Matching is
 * case-insensitive on purpose, like G1 — a case-folded checkout writes the
 * same file.
 *
 * PURE: no I/O. The caller supplies the file list a fleet change would touch
 * (and, to divert rather than refuse a changelog edit, the fragment to write).
 */
import { normalizeRepoPath } from '../authority/protected-paths.js';

/** Directory fragments live under; additive `*.md` files never collide. */
export const CHANGELOG_FRAGMENT_DIR = 'changelog.d';

export const CHANGELOG_FRAGMENT_KINDS = Object.freeze([
  'added', 'changed', 'fixed', 'removed', 'security', 'docs', 'chore',
] as const);
export type ChangelogFragmentKind = (typeof CHANGELOG_FRAGMENT_KINDS)[number];

const FRAGMENT_KINDS = new Set<string>(CHANGELOG_FRAGMENT_KINDS);

/** A bridge/job identifier usable inside a fragment filename. */
const FRAGMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const CHANGELOG_BASENAME = /^changelog(?:\.[a-z0-9]+)?$/;
const README_BASENAME = /^readme(?:\.[a-z0-9]+)?$/;
const AGENT_GUIDE_BASENAMES = new Set(['claude.md']);

/**
 * Dependency lockfiles by exact basename (any depth) plus a `*.lock`/`*.lockb`
 * suffix catch-all: a diff to a `*.lock` file is generated churn by
 * construction. Manifests (package.json, Cargo.toml, pyproject.toml, …) are
 * NOT refused — jobs legitimately bump a version or script; only the
 * machine-resolved lock is collision-bound.
 */
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'cargo.lock', 'go.sum', 'go.work.sum',
  'poetry.lock', 'uv.lock', 'pipfile.lock', 'gemfile.lock', 'package.resolved',
  'composer.lock', 'deno.lock', 'flake.lock', 'mix.lock', 'pubspec.lock',
  'podfile.lock', 'cartfile.resolved', 'packages.lock.json', 'paket.lock',
  'gradle.lockfile', 'conan.lock',
]);
const LOCKFILE_SUFFIX = /\.lockb?$/;

export type FleetEditCollisionRule =
  | 'unsafe-path'
  | 'changelog-singleton'
  | 'readme-singleton'
  | 'agent-guide'
  | 'lockfile';

export interface FleetEditRefusal {
  /** The path as the edit named it (normalized when safe to print). */
  path: string;
  rule: FleetEditCollisionRule;
  why: string;
  /**
   * 'changelog-fragment' when the edit could be carried by a `changelog.d`
   * fragment instead (a non-delete changelog edit); null when refusal is final.
   */
  redirect: 'changelog-fragment' | null;
}

/** One file a fleet change would write; `content: null` is a deletion. */
export interface FleetFileEdit {
  path: string;
  content: string | null;
}

const WHY: Record<Exclude<FleetEditCollisionRule, 'unsafe-path'>, string> = {
  'changelog-singleton':
    'every concurrent PR appends its entry to the same top section; the entry ships as a changelog.d fragment instead',
  'readme-singleton':
    'the project README is a collision-prone owner surface; fleet PRs never rewrite it',
  'agent-guide':
    'agent instruction files steer every later job; only an owner edits them',
  lockfile:
    'lockfiles are regenerated, never hand-edited, and are the most common merge-collision source',
};

function refusalFor(normalized: string): FleetEditRefusal | null {
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  if (CHANGELOG_BASENAME.test(basename)) {
    return { path: normalized, rule: 'changelog-singleton', why: WHY['changelog-singleton'], redirect: 'changelog-fragment' };
  }
  if (README_BASENAME.test(basename)) {
    return { path: normalized, rule: 'readme-singleton', why: WHY['readme-singleton'], redirect: null };
  }
  if (AGENT_GUIDE_BASENAMES.has(basename)) {
    return { path: normalized, rule: 'agent-guide', why: WHY['agent-guide'], redirect: null };
  }
  if (LOCKFILE_BASENAMES.has(basename) || LOCKFILE_SUFFIX.test(basename)) {
    return { path: normalized, rule: 'lockfile', why: WHY['lockfile'], redirect: null };
  }
  return null;
}

function unsafePathRefusal(rawPath: string): FleetEditRefusal {
  return {
    // eslint-disable-next-line no-control-regex
    path: String(rawPath).replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200),
    rule: 'unsafe-path',
    why: 'the edit names a path that cannot be normalized safely (absolute, "..", control characters or inside .git)',
    redirect: null,
  };
}

/** The refusal for one path, or null when the fleet may edit it. */
export function fleetEditCollision(rawPath: string): FleetEditRefusal | null {
  const normalized = normalizeRepoPath(rawPath);
  return normalized === null ? unsafePathRefusal(rawPath) : refusalFor(normalized);
}

/** Every collision among `paths` (one per path, in input order). */
export function fleetEditRefusals(paths: readonly string[]): FleetEditRefusal[] {
  const hits: FleetEditRefusal[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const hit = fleetEditCollision(raw);
    if (!hit || seen.has(hit.path)) continue;
    seen.add(hit.path);
    hits.push(hit);
  }
  return hits;
}

/** `changelog.d/<id>.<kind>.md`, or null when id or kind is unusable. */
export function changelogFragmentPath(id: string, kind: ChangelogFragmentKind): string | null {
  if (!FRAGMENT_ID.test(id) || !FRAGMENT_KINDS.has(kind)) return null;
  return `${CHANGELOG_FRAGMENT_DIR}/${id}.${kind}.md`;
}

const ENTRY_LIMIT = 32;
const ENTRY_MAX_CHARS = 500;
const HEADING: Record<ChangelogFragmentKind, string> = {
  added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed',
  security: 'Security', docs: 'Documentation', chore: 'Chore',
};

export interface ChangelogFragmentSpec {
  /** Bridge/job identifier rendered into the filename (letters, digits, `_`, `-`). */
  id: string;
  kind: ChangelogFragmentKind;
  /** 1–32 one-line entries; leading bullet markers are stripped. */
  entries: readonly string[];
}

function cleanEntries(entries: readonly string[]): string[] | null {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > ENTRY_LIMIT) return null;
  const cleaned: string[] = [];
  for (const raw of entries) {
    // eslint-disable-next-line no-control-regex
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    const text = raw.replace(/^[\s>*+-]+/, '').trimEnd();
    if (text.length < 1 || text.length > ENTRY_MAX_CHARS) return null;
    cleaned.push(text);
  }
  return cleaned;
}

/**
 * The fragment file a refused changelog edit becomes, or null when the spec
 * cannot produce a well-formed fragment (fail closed: the caller then treats
 * the changelog edit as refused rather than dropping the intent).
 */
export function renderChangelogFragment(spec: ChangelogFragmentSpec): FleetFileEdit | null {
  if (typeof spec !== 'object' || spec === null) return null;
  const path = changelogFragmentPath(spec.id, spec.kind);
  const entries = cleanEntries(spec.entries);
  if (path === null || entries === null) return null;
  const content = `### ${HEADING[spec.kind]}\n\n${entries.map((entry) => `- ${entry}`).join('\n')}\n`;
  return { path, content };
}

export interface FleetEditDiversion {
  /** Singleton changelog path whose edit was diverted. */
  from: string;
  /** Fragment path that carries the entry instead. */
  to: string;
}

export interface SanitizedFleetEdits {
  /** True only when nothing is refused. `edits` is then the publishable set. */
  ok: boolean;
  /** Allowed edits in input order, plus the diverted fragment (if any). */
  edits: FleetFileEdit[];
  refusals: FleetEditRefusal[];
  diverted: FleetEditDiversion[];
}

const MAX_EDITS = 50_000;
const MAX_CONTENT_CHARS = 8 * 1024 * 1024;

/**
 * Partition a fleet edit set into publishable edits and refusals.
 *
 * A changelog edit is DIVERTED — not refused — when `opts.changelog` renders
 * a valid fragment: the singleton file is left untouched and its entry lands
 * in `changelog.d/<id>.<kind>.md`. Every other collision, a changelog
 * deletion, or a changelog edit whose fragment cannot render is refused.
 *
 * Throws on a malformed edit set: a shape the bridge cannot reason about is
 * never half-applied.
 */
export function sanitizeFleetEdits(
  edits: readonly FleetFileEdit[],
  opts: { changelog?: ChangelogFragmentSpec | null } = {},
): SanitizedFleetEdits {
  if (!Array.isArray(edits) || edits.length > MAX_EDITS) {
    throw new Error('Invalid fleet edit set: a bounded array of edits is required');
  }
  const allowed: FleetFileEdit[] = [];
  const refusals: FleetEditRefusal[] = [];
  const divertedFrom: string[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    if (typeof edit !== 'object' || edit === null || typeof edit.path !== 'string' ||
      (edit.content !== null && (typeof edit.content !== 'string' || edit.content.length > MAX_CONTENT_CHARS))) {
      throw new Error('Invalid fleet edit set: every edit needs a string path and string-or-null content');
    }
    const normalized = normalizeRepoPath(edit.path);
    if (normalized === null) {
      refusals.push(unsafePathRefusal(edit.path));
      continue;
    }
    const hit = refusalFor(normalized);
    if (hit === null) {
      // One path wins once, case-folded like the checkout: a repeated path is the job racing itself.
      const identity = normalized.toLowerCase();
      if (seen.has(identity)) {
        refusals.push({ path: normalized, rule: 'unsafe-path', why: 'the edit set names the same file twice', redirect: null });
        continue;
      }
      seen.add(identity);
      allowed.push(edit);
      continue;
    }
    if (hit.rule === 'changelog-singleton' && edit.content !== null && opts.changelog != null) {
      divertedFrom.push(hit.path);
      continue;
    }
    // A changelog delete carries no entry text, so no fragment can stand in.
    refusals.push(hit.rule === 'changelog-singleton' && edit.content === null ? { ...hit, redirect: null } : hit);
  }
  const diverted: FleetEditDiversion[] = [];
  if (divertedFrom.length > 0) {
    const fragment = renderChangelogFragment(opts.changelog as ChangelogFragmentSpec);
    if (fragment === null) {
      // A fragment that cannot render never silently swallows the changelog edits.
      for (const from of divertedFrom) {
        refusals.push({ path: from, rule: 'changelog-singleton', why: WHY['changelog-singleton'], redirect: 'changelog-fragment' });
      }
    } else {
      for (const from of divertedFrom) diverted.push({ from, to: fragment.path });
      allowed.push(fragment);
    }
  }
  return { ok: refusals.length === 0, edits: allowed, refusals, diverted };
}
