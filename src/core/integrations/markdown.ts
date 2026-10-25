/**
 * M68: ashlr-md rendering integration — opt-in, best-effort, never-throws.
 *
 * When ashlr-md (https://github.com/ashlrai/ashlr-md) is installed, operators
 * can open generated Markdown (proposals, digests, specs) in the beautiful
 * AI-native viewer instead of receiving a raw terminal dump.
 *
 * The integration is strictly additive:
 *   - When ashlr-md is absent, every function degrades gracefully: no error,
 *     no side-effect, caller receives ok:false / rendered:false and falls back
 *     to its own terminal output.
 *   - When ashlr-md IS present, a temp .md file is written to
 *     ~/.ashlr/tmp (or os.tmpdir() as fallback) and opened via `mdopen <file>`.
 *     mdopen runs bounded and synchronously; only exit 0 counts as rendered.
 *
 * CLI command confirmed from ashlr-md's install.sh:
 *   mdopen <path-to-file.md>
 * Installed to /usr/local/bin/mdopen or ~/.local/bin/mdopen by the ashlr-md
 * installer script; the Linux .deb and macOS app put it at a fixed path off PATH.
 *
 * Seam: `ashlr inbox` / `ashlr digest` will call `presentMarkdown(title, body)`
 * and fall back to their existing terminal rendering when rendered === false.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Upper bound (ms) for a blocking `mdopen` call. mdopen itself returns within
 * ~10s (ashlr-md PR #43); this is the backstop.
 */
const MDOPEN_TIMEOUT_MS = 15_000;

/**
 * Fixed install locations where the ashlr-md packages put `mdopen` without
 * adding it to PATH (Linux .deb, macOS app bundle).
 */
const MDOPEN_FIXED_PATHS: readonly string[] = [
  '/usr/lib/Ashlr MD/mdopen',
  '/Applications/Ashlr MD.app/Contents/Resources/mdopen',
];

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the `mdopen` binary: PATH first (searched in-process, with .exe
 * on Windows, so no `which`/`where` is needed), then the fixed install
 * locations. Returns the absolute path, or null. Never throws. A `.cmd` shim
 * is not a candidate: spawnSync cannot launch one without a shell (EINVAL
 * since CVE-2024-27980), and the path is never run through a shell.
 */
export function resolveMdopen(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  fixedPaths: readonly string[] = MDOPEN_FIXED_PATHS,
): string | null {
  try {
    const names = platform === 'win32' ? ['mdopen.exe', 'mdopen'] : ['mdopen'];
    const pathVar = env['PATH'] ?? env['Path'] ?? '';
    for (const dir of pathVar.split(platform === 'win32' ? ';' : ':')) {
      if (!dir) continue;
      for (const name of names) {
        const candidate = join(dir, name);
        if (isFile(candidate)) return candidate;
      }
    }
    for (const candidate of fixedPaths) {
      if (isFile(candidate)) return candidate;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Returns true when the ashlr-md `mdopen` CLI can be found (PATH or a known
 * install location). Never throws.
 */
export function ashlrMdInstalled(): boolean {
  return resolveMdopen() !== null;
}

/**
 * Open a .md file in the ashlr-md viewer.
 *
 * Runs the resolved `mdopen` synchronously (bounded by MDOPEN_TIMEOUT_MS) and
 * reports ok:true only when it exits 0, so callers fall back to terminal
 * output when the viewer cannot open (e.g. headless). mdopen exiting 0 with
 * "not confirmed" means launched-but-unconfirmed, which counts as opened.
 * Never throws.
 */
export function openInAshlrMd(filePath: string): { ok: boolean; detail: string } {
  const bin = resolveMdopen();
  if (bin === null) {
    return { ok: false, detail: 'mdopen not found on PATH — ashlr-md not installed' };
  }

  try {
    const res = spawnSync(bin, [filePath], {
      timeout: MDOPEN_TIMEOUT_MS,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
    const stderr = (res.stderr ?? '').trim();
    if (res.error) {
      return { ok: false, detail: `mdopen failed: ${res.error.message}${stderr ? ` — ${stderr}` : ''}` };
    }
    if (res.status !== 0) {
      const why = res.status === null ? `killed (${res.signal ?? 'signal'})` : `exit ${res.status}`;
      return { ok: false, detail: `mdopen ${why}${stderr ? `: ${stderr}` : ''}` };
    }
    return { ok: true, detail: `opened ${filePath} in ashlr-md${stderr ? ` (${stderr})` : ''}` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `mdopen spawn failed: ${msg}` };
  }
}

/**
 * Write a Markdown document to a temp file and return its path.
 *
 * Writes to ~/.ashlr/tmp/ (created on demand) with a timestamp-based name so
 * multiple calls don't collide. Falls back to os.tmpdir() if the ashlr dir
 * cannot be created. Returns null on any write failure. Never throws.
 */
export function renderToTempMarkdown(title: string, body: string): string | null {
  try {
    // Prefer ~/.ashlr/tmp so files land in a predictable, inspectable place.
    let dir: string;
    try {
      dir = join(homedir(), '.ashlr', 'tmp');
      mkdirSync(dir, { recursive: true });
    } catch {
      dir = tmpdir();
    }

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ashlr-doc';
    const ts = Date.now();
    // Add a random suffix so two calls in the same millisecond never collide.
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `${slug}-${ts}-${rand}.md`;
    const filePath = join(dir, filename);

    const content = `# ${title}\n\n${body}\n`;
    writeFileSync(filePath, content, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Write a temp Markdown file and open it in ashlr-md if installed.
 *
 * This is the primary seam for `ashlr inbox` / `ashlr digest`. Callers should
 * check `rendered` and fall back to terminal output when false.
 *
 * @returns
 *   - { rendered: true,  path: string, detail: string } — file written + viewer launched
 *   - { rendered: false, path: string, detail: string } — file written but viewer absent/failed
 *   - { rendered: false, detail: string }               — temp write failed
 */
export function presentMarkdown(
  title: string,
  body: string,
): { rendered: boolean; path?: string; detail: string } {
  const path = renderToTempMarkdown(title, body);
  if (path === null) {
    return { rendered: false, detail: 'failed to write temp markdown file' };
  }

  const result = openInAshlrMd(path);
  return {
    rendered: result.ok,
    path,
    detail: result.detail,
  };
}
