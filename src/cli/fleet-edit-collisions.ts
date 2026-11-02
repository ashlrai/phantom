/**
 * `ashlr fleet edit-collisions` — READ-ONLY admission check for fleet edit paths.
 *
 * Surfaces the collision-free-edits admission rule
 * (src/core/fleet/collision-free-edits.ts) before a fleet change becomes a PR:
 * concurrent jobs collide on CHANGELOG / README / CLAUDE.md singletons and on
 * regenerated lockfiles, so the bridge refuses edit sets that touch them. A
 * publish step can pipe `git diff --name-only` in and find out first.
 *
 * Paths come from the positional arguments (optionally introduced by `--paths`)
 * and, when stdin is not a TTY, from newline- or NUL-delimited standard input.
 * Never writes, never touches the network, grants no merge permission.
 */
import type { Readable } from 'node:stream';
import { looksLikeOption } from './args.js';
import {
  CHANGELOG_FRAGMENT_DIR,
  CHANGELOG_FRAGMENT_KINDS,
  fleetEditRefusals,
} from '../core/fleet/collision-free-edits.js';

/** Fragment path a refused changelog edit is carried by once a job id is known. */
const FRAGMENT_TEMPLATE = `${CHANGELOG_FRAGMENT_DIR}/<id>.<kind>.md`;

/** A `git diff --name-only` line is ~100 bytes; 1 MiB is generous headroom. */
const MAX_STDIN_BYTES = 1024 * 1024;
/** Same bound sanitizeFleetEdits applies to the edit set it admits. */
const MAX_PATHS = 50_000;

const HELP = `Usage: ashlr fleet edit-collisions [--json] [--paths] [<file>...] [-- <file>...]

READ-ONLY: would the bridge refuse any of these fleet edit paths?
Paths are the positional arguments (optionally introduced by --paths) plus,
when stdin is not a TTY, a newline- or NUL-delimited list on standard input —
a publish step can pipe \`git diff --name-only\` (-z for NUL) into it.

Each refusal names the path, the rule and the reason. A changelog refusal is
divertable: ship the entry as ${FRAGMENT_TEMPLATE}
where kind is one of ${CHANGELOG_FRAGMENT_KINDS.join(', ')}.

Exit 0 no refusals, 1 at least one refusal, 2 invalid input. Advisory only:
reads no repository state, writes nothing, grants no merge permission.
`;

export interface EditCollisionsDeps {
  /** Path source read when not a TTY; defaults to process.stdin. */
  stdin?: Readable;
  /** Overrides TTY detection on `stdin` (tests). */
  stdinIsTty?: boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Bounded stdin read into a path list: NUL-delimited when present, else LF/CRLF lines. */
async function readPathList(stdin: Readable): Promise<{ ok: true; paths: string[] } | { ok: false; message: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buffer.length;
      if (bytes > MAX_STDIN_BYTES) {
        stdin.destroy();
        return { ok: false, message: `stdin exceeds ${MAX_STDIN_BYTES} bytes` };
      }
      chunks.push(buffer);
    }
  } catch {
    stdin.destroy();
    return { ok: false, message: 'stdin read error' };
  }
  const text = Buffer.concat(chunks, bytes).toString('utf8');
  const parts = text.includes('\0')
    ? text.split('\0')
    : text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  return { ok: true, paths: parts.filter(part => part.length > 0) };
}

export async function cmdFleetEditCollisions(
  args: readonly string[],
  deps: EditCollisionsDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const invalid = (message: string): number => { err(`error: ${message}\n`); return 2; };

  const paths: string[] = [];
  let json = false;
  let positional = false;
  for (const arg of args) {
    if (positional) { paths.push(arg); continue; }
    if (arg === '--') { positional = true; continue; }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--help' || arg === '-h') { out(HELP); return 0; }
    if (arg === '--paths') continue; // marker only: positionals are paths either way
    if (looksLikeOption(arg)) return invalid(`unknown option: ${arg}`);
    paths.push(arg);
  }

  const stdin = deps.stdin ?? process.stdin;
  const tty = deps.stdinIsTty ?? Boolean((stdin as { isTTY?: boolean }).isTTY);
  if (paths.length === 0 && tty) {
    return invalid('no paths to check: pass files as arguments or pipe a newline-delimited list on stdin');
  }
  if (!tty) {
    const read = await readPathList(stdin);
    if (!read.ok) return invalid(read.message);
    paths.push(...read.paths);
  }
  if (paths.length > MAX_PATHS) return invalid(`too many paths (limit ${MAX_PATHS})`);

  const refusals = fleetEditRefusals(paths).map(refusal => ({
    path: refusal.path,
    rule: refusal.rule,
    why: refusal.why,
    redirect: refusal.redirect,
    useInstead: refusal.redirect === 'changelog-fragment' ? FRAGMENT_TEMPLATE : null,
  }));
  const report = {
    schema: 'fleet.edit-collisions.v1',
    ok: refusals.length === 0,
    checked: paths.length,
    refusals,
  };
  if (json) {
    out(JSON.stringify(report) + '\n');
  } else {
    out(report.ok
      ? `edit-collisions: ok (${paths.length} path${paths.length === 1 ? '' : 's'} checked)\n`
      : `edit-collisions: refused ${refusals.length} of ${paths.length} paths\n`);
    for (const refusal of refusals) {
      out(`  refused ${refusal.path} [${refusal.rule}] ${refusal.why}` +
        (refusal.useInstead ? `; use ${refusal.useInstead}` : '') + '\n');
    }
  }
  return report.ok ? 0 : 1;
}
