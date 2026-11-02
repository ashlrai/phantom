/**
 * `ashlr fleet changelog` — write and fold changelog.d fragments.
 *
 * The bridge diverts a fleet CHANGELOG edit into `changelog.d/<id>.<kind>.md`
 * (src/core/fleet/collision-free-edits.ts) so concurrent PRs never collide on
 * CHANGELOG.md's top section. This verb is the agent-facing half:
 *
 *   add   renders one fragment through renderChangelogFragment and writes it
 *         with `wx` — an existing file is refused, never overwritten;
 *   fold  lists the fragments and replays them into the first
 *         `## [x.y.z] — Unreleased` section of CHANGELOG.md. Without --apply
 *         it prints a preview (folded paths, skipped paths with reasons, and
 *         the new top section) and writes nothing; with --apply it writes
 *         CHANGELOG.md and deletes only the fragments it folded.
 *
 * --root <abs> selects the repository root (default: the git toplevel of the
 * working directory). Local files only — no network, no commits.
 */
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { looksLikeOption } from './args.js';
import {
  CHANGELOG_FRAGMENT_DIR,
  CHANGELOG_FRAGMENT_KINDS,
  changelogFragmentPath,
  renderChangelogFragment,
  type ChangelogFragmentKind,
} from '../core/fleet/collision-free-edits.js';
import {
  foldChangelog,
  listFragments,
  unreleasedSection,
  type FragmentFs,
} from '../core/fleet/changelog-fold.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: ashlr fleet changelog add --id <id> --kind <kind> <entry>... [--root <abs>] [--json]
       ashlr fleet changelog fold [--apply] [--json] [--root <abs>]

add    write changelog.d/<id>.<kind>.md holding 1–32 one-line entries.
       --id is letters, digits, '_' and '-'; --kind is one of
       ${CHANGELOG_FRAGMENT_KINDS.join(', ')}. Refuses (exit 1) when the
       fragment already exists — it is never overwritten.
fold   fold every changelog.d fragment into the first '## [x.y.z] —
       Unreleased' section of CHANGELOG.md. Without --apply nothing is
       written: the preview lists folded and skipped fragment paths and the
       new top section. With --apply CHANGELOG.md is written and only the
       fragments that folded are deleted.
--root <abs> repository root; default is the git toplevel of the cwd.
Exit 0 ok, 1 refused or failed, 2 usage. Local files only: no network,
no commits, no version bumps.`;

/** The fs surface the verb needs beyond listFragments' own seam. */
export interface ChangelogFs extends FragmentFs {
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
  writeFileSync(path: string, data: string, options?: { flag?: string }): unknown;
  unlinkSync(path: string): unknown;
}

export interface FleetChangelogDeps {
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** cwd for the git-toplevel default (tests). */
  cwd?: string;
  /** fs seam (tests); defaults to node:fs. */
  fs?: ChangelogFs;
  /** git-toplevel seam (tests); defaults to `git rev-parse --show-toplevel`. */
  toplevel?: (cwd: string) => string | null;
}

function defaultToplevel(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', timeout: 15_000,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return null;
    const top = result.stdout.trim();
    return top === '' ? null : top;
  } catch {
    return null;
  }
}

interface ParsedArgs {
  json: boolean;
  apply: boolean;
  root?: string;
  id?: string;
  kind?: string;
  positionals: string[];
}

/**
 * Parse the flag set shared by both actions. Returns the parse or a message
 * for exit-2 refusal. `--` ends option parsing so an entry like `- hotfix`
 * stays a positional.
 */
function parseArgs(args: readonly string[]): ParsedArgs | string {
  const parsed: ParsedArgs = { json: false, apply: false, positionals: [] };
  const seen = new Set<string>();
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (positional) { parsed.positionals.push(arg); continue; }
    if (arg === '--') { positional = true; continue; }
    if (arg === '--json' || arg === '--apply') {
      const key = arg === '--json' ? 'json' : 'apply';
      if (seen.has(arg)) return `duplicate option: ${arg}`;
      seen.add(arg);
      parsed[key] = true;
      continue;
    }
    if (arg === '--root' || arg === '--id' || arg === '--kind') {
      if (seen.has(arg)) return `duplicate option: ${arg}`;
      seen.add(arg);
      const value = args[++i];
      if (typeof value !== 'string' || value === '') return `${arg} requires a value`;
      if (arg === '--root') {
        if (!isAbsolute(value)) return '--root must be an absolute path';
        parsed.root = value;
      } else if (arg === '--id') {
        parsed.id = value;
      } else {
        parsed.kind = value;
      }
      continue;
    }
    if (looksLikeOption(arg)) return `unknown option: ${arg}`;
    parsed.positionals.push(arg);
  }
  return parsed;
}

export async function cmdFleetChangelog(
  args: readonly string[],
  deps: FleetChangelogDeps = {},
): Promise<number> {
  const output = deps.output ?? ((text: string) => console.log(text));
  const error = deps.error ?? ((text: string) => console.error(text));
  const invalid = (message: string): number => {
    error(`error: ${message}. ${usage.split('\n')[0]}`);
    return 2;
  };
  if (args.includes('--help') || args.includes('-h')) { output(usage); return 0; }
  const action = args[0];
  if (action !== 'add' && action !== 'fold') {
    return invalid(action === undefined ? 'missing action' : `unknown action: ${action}`);
  }
  const parsed = parseArgs(args.slice(1));
  if (typeof parsed === 'string') return invalid(parsed);
  if (parsed.apply && action !== 'fold') return invalid('--apply only applies to fold');
  if (parsed.id !== undefined && action !== 'add') return invalid('--id only applies to add');
  if (parsed.kind !== undefined && action !== 'add') return invalid('--kind only applies to add');

  const fs = deps.fs ?? (nodeFs as unknown as ChangelogFs);
  const toplevel = deps.toplevel ?? defaultToplevel;
  const root = parsed.root !== undefined
    ? resolve(parsed.root)
    : (() => {
      const top = toplevel(deps.cwd ?? process.cwd());
      return top === null ? null : resolve(top);
    })();
  if (root === null) {
    error('error: could not resolve the repository root; pass --root <abs>');
    return 1;
  }

  if (action === 'add') {
    if (parsed.id === undefined) return invalid('missing --id');
    if (parsed.kind === undefined) return invalid('missing --kind');
    if (parsed.positionals.length < 1 || parsed.positionals.length > 32) {
      return invalid('add needs 1 to 32 entries');
    }
    const kind = parsed.kind.toLowerCase();
    if (changelogFragmentPath(parsed.id, kind as ChangelogFragmentKind) === null) {
      return invalid(`invalid --id or --kind (kind is one of ${CHANGELOG_FRAGMENT_KINDS.join(', ')})`);
    }
    const fragment = renderChangelogFragment({
      id: parsed.id, kind: kind as ChangelogFragmentKind, entries: parsed.positionals,
    });
    if (fragment === null || fragment.content === null) {
      return invalid('entries must be non-empty text of at most 500 characters each');
    }
    const dir = join(root, CHANGELOG_FRAGMENT_DIR);
    const target = join(root, fragment.path);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // `wx` fails on an existing path, so the refusal is race-free.
      fs.writeFileSync(target, fragment.content, { flag: 'wx' });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const message = code === 'EEXIST'
        ? `fragment already exists: ${fragment.path}`
        : `could not write ${fragment.path}`;
      if (parsed.json) {
        output(JSON.stringify(sanitizePublicJson({ schema: 'fleet.changelog.v1', action: 'add', ok: false, reason: message })));
      } else {
        error(`error: ${message}`);
      }
      return 1;
    }
    if (parsed.json) {
      output(JSON.stringify(sanitizePublicJson({ schema: 'fleet.changelog.v1', action: 'add', ok: true, path: fragment.path })));
    } else {
      output(`fleet changelog: wrote ${fragment.path}`);
    }
    return 0;
  }

  // fold
  const changelogPath = join(root, 'CHANGELOG.md');
  let changelogText: string;
  try {
    changelogText = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    error(`error: could not read ${changelogPath}`);
    return 1;
  }
  const dir = join(root, CHANGELOG_FRAGMENT_DIR);
  const listed = listFragments(dir, fs);
  // Fragments carry the fs path listFragments used; the repo-relative spelling
  // is what reports and folded/skipped lists show.
  const rel = (path: string): string =>
    path.startsWith(`${dir}/`) ? `${CHANGELOG_FRAGMENT_DIR}/${path.slice(dir.length + 1)}` : path;
  const result = foldChangelog(changelogText, listed.fragments);
  const folded = result.folded.map(rel);
  const skipped = [...listed.skipped, ...result.skipped]
    .map((skip) => ({ path: rel(skip.path), reason: skip.reason }));
  const noUnreleased = result.skipped.some((s) => s.reason === 'no-unreleased-section');
  const section = unreleasedSection(result.text);
  if (parsed.json) {
    output(JSON.stringify(sanitizePublicJson({
      schema: 'fleet.changelog.v1',
      action: 'fold',
      ok: !noUnreleased,
      apply: parsed.apply,
      changelog: 'CHANGELOG.md',
      folded,
      skipped,
      section,
    })));
  } else {
    const lines = [`fleet changelog fold: ${parsed.apply ? 'APPLY' : 'DRY-RUN — no changes made'}`];
    for (const path of folded) lines.push(`  folded: ${path}`);
    for (const skip of skipped) lines.push(`  skipped: ${skip.path} (${skip.reason})`);
    if (section !== null) lines.push('--- top section ---', section.trimEnd());
    output(lines.join('\n'));
  }
  if (noUnreleased) {
    error('error: CHANGELOG.md has no "## [x.y.z] — Unreleased" section');
    return 1;
  }
  if (!parsed.apply) return 0;
  if (result.text !== changelogText) {
    try {
      fs.writeFileSync(changelogPath, result.text);
    } catch {
      error(`error: could not write ${changelogPath}`);
      return 1;
    }
  }
  let failed = false;
  for (const path of result.folded) {
    try {
      fs.unlinkSync(path);
    } catch {
      error(`error: could not delete folded fragment ${rel(path)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
