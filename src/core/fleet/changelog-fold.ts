/**
 * Changelog fragment fold (VISION collision-free-prs).
 *
 * `collision-free-edits.ts` diverts a fleet changelog edit into an additive
 * `changelog.d/<id>.<kind>.md` fragment so concurrent PRs never collide on
 * CHANGELOG.md's top section. This module is the other half: it lists the
 * fragments on disk and folds their bullet lines into the FIRST
 * `## [x.y.z] — Unreleased` section — under the matching `### Heading`,
 * creating the subsection at the end of the section when it is missing.
 *
 * The fold never duplicates a bullet that is already in the target
 * subsection exactly, and never touches anything outside the Unreleased
 * section — a dated `## [x.y.z] — <date>` section below it stays
 * byte-identical. `scripts/extract-changelog.mjs` and
 * `scripts/freshness/sync.mjs` parse these headings, so the emitted format
 * matches the existing `### Heading` + `- bullet` style exactly.
 *
 * PURE apart from the injected fs: `listFragments` reads only through the
 * `FragmentFs` seam and `foldChangelog` is pure text surgery.
 */
import {
  CHANGELOG_FRAGMENT_KINDS,
  changelogFragmentPath,
  type ChangelogFragmentKind,
} from './collision-free-edits.js';

/** Fragments larger than this are skipped — a fragment is a few bullet lines. */
export const CHANGELOG_FRAGMENT_MAX_BYTES = 16 * 1024;

/**
 * Canonical `### Heading` text per kind — must stay in sync with the
 * renderer's HEADING map in collision-free-edits.ts.
 */
const KIND_HEADING: Record<ChangelogFragmentKind, string> = {
  added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed',
  security: 'Security', docs: 'Documentation', chore: 'Chore',
};
const KNOWN_HEADINGS = new Set<string>(Object.values(KIND_HEADING));
const KIND_ORDER = new Map<string, number>(CHANGELOG_FRAGMENT_KINDS.map((kind, i) => [kind, i]));

const FRAGMENT_NAME = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z]+)\.md$/;
const UNRELEASED_HEADING = /^## \[[0-9]+\.[0-9]+\.[0-9]+\] [—–-] Unreleased[ \t]*$/;
const SECTION_BOUNDARY = /^## /;
const SUBSECTION_HEADING = /^### ([^#].*?)[ \t]*$/;
const BULLET_LINE = /^- /;

/** The narrow fs surface `listFragments` needs; `node:fs` satisfies it. */
export interface FragmentFs {
  readdirSync(dir: string): string[];
  lstatSync(path: string): { isSymbolicLink(): boolean; isFile(): boolean; size: number };
  readFileSync(path: string, encoding: 'utf8'): string;
}

export interface ChangelogFragment {
  /** `join(dir, name)` — whatever path spelling the caller's `dir` used. */
  path: string;
  /** The fragment's basename inside `dir` (`<id>.<kind>.md`). */
  name: string;
  /** Fragment identifier from the filename. */
  id: string;
  /** Fragment kind from the filename. */
  kind: ChangelogFragmentKind;
  /** The `### Heading` text the fragment asks for. */
  heading: string;
  /** Bullet lines (`- entry`) carried by the fragment, verbatim. */
  bullets: string[];
}

export interface SkippedFragment {
  path: string;
  reason:
    | 'symlink'
    | 'not-a-file'
    | 'oversize'
    | 'no-heading'
    | 'unknown-heading'
    | 'no-bullets'
    | 'unreadable'
    | 'no-unreleased-section'
    | 'empty-fragment';
}

export interface ListedFragments {
  /** Usable fragments sorted by kind order (CHANGELOG_FRAGMENT_KINDS), then id. */
  fragments: ChangelogFragment[];
  skipped: SkippedFragment[];
}

/**
 * One fragment the fold may place: the fields `foldChangelog` consumes.
 * `ChangelogFragment` satisfies it structurally.
 */
export interface FoldableFragment {
  path: string;
  heading: string;
  bullets: readonly string[];
}

export interface FoldResult {
  /** The changelog text after folding — unchanged when nothing folded. */
  text: string;
  /** Paths of the fragments whose bullets were placed (or already present). */
  folded: string[];
  skipped: SkippedFragment[];
}

/**
 * Read `dir` (the changelog.d directory) into validated fragments.
 *
 * Names that are not `<id>.<kind>.md` with a known kind are IGNORED — not
 * reported — so unrelated notes in the directory never block a fold. A name
 * that parses is then refused (reported skipped) when it is a symlink, not a
 * regular file, over `CHANGELOG_FRAGMENT_MAX_BYTES`, unreadable, or carries
 * no known `### Heading` or bullet lines.
 *
 * A missing directory is not an error: `{ fragments: [], skipped: [] }`.
 */
export function listFragments(dir: string, fs: FragmentFs): ListedFragments {
  const skipped: SkippedFragment[] = [];
  const parsed: { name: string; id: string; kind: ChangelogFragmentKind }[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT') {
      return { fragments: [], skipped: [] };
    }
    throw err;
  }
  for (const name of names) {
    const match = FRAGMENT_NAME.exec(name);
    if (match === null) continue;
    const kind = match[2]!;
    if (!KIND_ORDER.has(kind)) continue;
    // The filename parsed and the kind is known, so the canonical path
    // validator can only refuse on the id — which FRAGMENT_NAME already bounds.
    if (changelogFragmentPath(match[1]!, kind as ChangelogFragmentKind) === null) continue;
    parsed.push({ name, id: match[1]!, kind: kind as ChangelogFragmentKind });
  }
  parsed.sort((a, b) =>
    (KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const joinPath = (name: string): string =>
    dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}/${name}`;
  const fragments: ChangelogFragment[] = [];
  for (const entry of parsed) {
    const path = joinPath(entry.name);
    let stat: { isSymbolicLink(): boolean; isFile(): boolean; size: number };
    try {
      stat = fs.lstatSync(path);
    } catch {
      skipped.push({ path, reason: 'unreadable' });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path, reason: 'symlink' });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path, reason: 'not-a-file' });
      continue;
    }
    if (stat.size > CHANGELOG_FRAGMENT_MAX_BYTES) {
      skipped.push({ path, reason: 'oversize' });
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(path, 'utf8');
    } catch {
      skipped.push({ path, reason: 'unreadable' });
      continue;
    }
    const lines = content.split('\n');
    const heading = lines.flatMap((line) => {
      const sub = SUBSECTION_HEADING.exec(line);
      return sub === null ? [] : [sub[1]!];
    })[0];
    if (heading === undefined) {
      skipped.push({ path, reason: 'no-heading' });
      continue;
    }
    if (!KNOWN_HEADINGS.has(heading)) {
      skipped.push({ path, reason: 'unknown-heading' });
      continue;
    }
    const bullets = lines.filter((line) => BULLET_LINE.test(line));
    if (bullets.length === 0) {
      skipped.push({ path, reason: 'no-bullets' });
      continue;
    }
    fragments.push({ path, name: entry.name, id: entry.id, kind: entry.kind, heading, bullets });
  }
  return { fragments, skipped };
}

/**
 * Fold fragment bullets into the first `## [x.y.z] — Unreleased` section.
 *
 * Each fragment's bullets join the `### Heading` subsection they name —
 * appended after the subsection's last content line, or the subsection is
 * created at the end of the Unreleased section (before the next `## `
 * heading) when missing. A bullet already present verbatim in the target
 * subsection is not duplicated. Nothing outside the section changes.
 *
 * With no Unreleased heading the text is returned unchanged and every
 * fragment is reported skipped with reason 'no-unreleased-section'.
 */
export function foldChangelog(changelogText: string, fragments: readonly FoldableFragment[]): FoldResult {
  const skipped: SkippedFragment[] = [];
  const lines = changelogText.split('\n');
  const start = lines.findIndex((line) => UNRELEASED_HEADING.test(line));
  if (start === -1) {
    for (const fragment of fragments) {
      skipped.push({ path: fragment.path, reason: 'no-unreleased-section' });
    }
    return { text: changelogText, folded: [], skipped };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_BOUNDARY.test(lines[i]!)) { end = i; break; }
  }
  const folded: string[] = [];
  for (const fragment of fragments) {
    if (fragment.bullets.length === 0) {
      skipped.push({ path: fragment.path, reason: 'empty-fragment' });
      continue;
    }
    // Locate the target `### Heading` inside [start+1, end).
    let head = -1;
    for (let i = start + 1; i < end; i++) {
      const sub = SUBSECTION_HEADING.exec(lines[i]!);
      if (sub !== null && sub[1] === fragment.heading) { head = i; break; }
    }
    if (head === -1) {
      // Missing heading: create the subsection at the end of the Unreleased
      // section, before the next `## ` heading or EOF.
      const block: string[] = [`### ${fragment.heading}`, ...fragment.bullets, ''];
      if (end > 0 && lines[end - 1] !== '') block.unshift('');
      lines.splice(end, 0, ...block);
      end += block.length;
      folded.push(fragment.path);
      continue;
    }
    // Subsection end: next `### ` or the section boundary.
    let subEnd = end;
    for (let i = head + 1; i < end; i++) {
      if (SUBSECTION_HEADING.test(lines[i]!)) { subEnd = i; break; }
    }
    const existing = new Set<string>();
    let lastContent = head;
    for (let i = head + 1; i < subEnd; i++) {
      const line = lines[i]!;
      existing.add(line);
      if (line !== '') lastContent = i;
    }
    const fresh = fragment.bullets.filter((bullet) => {
      if (existing.has(bullet)) return false;
      existing.add(bullet);
      return true;
    });
    if (fresh.length > 0) {
      lines.splice(lastContent + 1, 0, ...fresh);
      end += fresh.length;
    }
    folded.push(fragment.path);
  }
  return { text: lines.join('\n'), folded, skipped };
}

/**
 * The first `## [x.y.z] — Unreleased` section's text (heading line through
 * the line before the next `## `), or null when the changelog has none.
 * Used for fold previews.
 */
export function unreleasedSection(changelogText: string): string | null {
  const lines = changelogText.split('\n');
  const start = lines.findIndex((line) => UNRELEASED_HEADING.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_BOUNDARY.test(lines[i]!)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}
