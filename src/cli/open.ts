/**
 * cli/open.ts — Launch items in editor, file manager, or terminal.
 *
 * All launchers use spawn (detached, unref'd) so the CLI process exits
 * immediately. Errors are swallowed — never throw; open operations are
 * best-effort UI conveniences.
 *
 * Cross-platform: macOS uses `open`, Windows uses `explorer`/`start`, Linux
 * uses `xdg-open`. The editor deep-link URL is built by a pure, OS-agnostic
 * helper (`editorDeepLink`) so the same input yields the same URL on any host.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { AshlrConfig } from '../core/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget spawn. Detaches the child process so the parent can exit
 * without waiting. Errors are silently discarded.
 */
function fire(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    // A missing opener emits 'error' asynchronously; ignore it like a throw.
    child.on('error', () => {});
    child.unref();
  } catch {
    // best-effort — never propagate
  }
}

/**
 * Treat a path as absolute if it looks absolute on EITHER platform — POSIX
 * (`/x`), Windows drive (`C:\x` / `C:/x`), or UNC/rooted (`\x`). This avoids
 * `path.resolve()` rewriting a POSIX path into a drive-relative Windows path
 * (and vice-versa), which would corrupt deep links built on the other host.
 */
function isAbsLike(p: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(p) || isAbsolute(p);
}

/** Open a URL/handler via the platform's default opener (best-effort). */
function openUrl(url: string): void {
  if (process.platform === 'darwin') fire('open', [url]);
  else if (process.platform === 'win32') fire('cmd', ['/c', 'start', '', url]);
  else fire('xdg-open', [url]);
}

// ---------------------------------------------------------------------------
// Pure deep-link builder (platform-agnostic — safe to unit-test anywhere)
// ---------------------------------------------------------------------------

/**
 * Build an editor deep-link URL (`cursor://file…` or `vscode://file…`) for an
 * absolute path.
 *
 * Pure and OS-independent:
 *  - normalizes `\` → `/` so Windows paths produce a valid URL;
 *  - ensures a single leading slash (`C:/Users/…` → `/C:/Users/…`);
 *  - percent-encodes each path segment (spaces, `&`, etc.) but preserves a
 *    drive-letter colon (`C:`), which editors expect literal in the URL;
 *  - does NOT platform-resolve, so a POSIX input stays POSIX and a Windows
 *    input stays Windows regardless of the host OS.
 */
export function editorDeepLink(path: string, editor: AshlrConfig['editor']): string {
  const abs = isAbsLike(path) ? path : resolve(path);
  let p = abs.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`; // Windows "C:/…" → "/C:/…"
  const enc = p
    .split('/')
    .map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  const scheme = editor === 'vscode' ? 'vscode' : 'cursor';
  return `${scheme}://file${enc}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open `path` in the configured editor using a deep-link URL.
 *
 *  - Cursor → `cursor://file<abs>`   (default)
 *  - VSCode → `vscode://file<abs>`   (when `cfg.editor === 'vscode'`)
 *
 * The deep link is launched via the platform opener. If the scheme handler is
 * not registered (e.g. the app is not installed) the OS silently does nothing,
 * so callers may retry via openInFinder.
 */
export function openInEditor(path: string, cfg: AshlrConfig): void {
  // Markdown → Ashlr MD when installed (opt out: cfg.markdownOpener = 'editor').
  const md = planMarkdownOpen(path, cfg);
  if (md.kind === 'ashlr-md') {
    openUrl(md.url);
    return;
  }
  openUrl(editorDeepLink(path, cfg.editor));
}

/**
 * The deep link for a file AT a line: Cursor and VS Code both accept a
 * `:<line>` suffix after the (encoded) path — `vscode://file/a/b.ts:42`.
 */
export function editorDeepLinkAt(path: string, line: number, editor: AshlrConfig['editor']): string {
  const base = editorDeepLink(path, editor);
  return Number.isInteger(line) && line > 0 ? `${base}:${line}` : base;
}

/** Open `path` at `line` in the configured editor (the wiki's citations). */
export function openInEditorAt(path: string, line: number, cfg: AshlrConfig): void {
  openUrl(editorDeepLinkAt(path, line, cfg.editor));
}

/**
 * Reveal `path` in the OS file manager (Finder / Explorer / default handler).
 * Opens directories in the file manager and files with their default app.
 */
export function openInFinder(path: string): void {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') fire('open', [abs]);
  else if (process.platform === 'win32') fire('explorer', [abs]);
  else fire('xdg-open', [abs]);
}

/**
 * Open a new terminal window cd'd to `path` (best-effort).
 *
 *  - macOS   → `open -a Terminal <dir>`
 *  - Windows → `start cmd /k cd /d <dir>`
 *  - Linux   → `x-terminal-emulator --working-directory <dir>`
 *
 * No guarantee for non-default terminals (iTerm2, Windows Terminal, etc.).
 */
export function openInTerminal(path: string): void {
  const abs = isAbsLike(path) ? path : resolve(path);
  if (process.platform === 'darwin') {
    fire('open', ['-a', 'Terminal', abs]);
  } else if (process.platform === 'win32') {
    fire('cmd', ['/c', 'start', 'cmd', '/k', `cd /d "${abs}"`]);
  } else {
    fire('x-terminal-emulator', ['--working-directory', abs]);
  }
}

// ---------------------------------------------------------------------------
// Markdown opener: Ashlr MD out of the box
// ---------------------------------------------------------------------------
/*
 * Ashlr MD as Phantom's out-of-box Markdown opener.
 *
 * When Phantom opens a Markdown file (CLI `phantom open`, the web/desktop
 * `POST /api/open`), it prefers Ashlr MD (https://github.com/ashlrai/ashlr-md)
 * via its `mdopener://open?path=…` URL scheme. If Ashlr MD is not installed,
 * or the user opts out with `"markdownOpener": "editor"` in config, the
 * existing editor deep link is used as a graceful fallback.
 *
 * Detection and URL building are pure / injectable so they test on any host.
 */


export type MarkdownOpenerPref = 'ashlr-md' | 'editor';

export const ASHLR_MD_REPO = 'https://github.com/ashlrai/ashlr-md';
export const ASHLR_MD_RELEASES = `${ASHLR_MD_REPO}/releases/latest`;

const MD_EXT = /\.(md|markdown|mdown|mkd|mdx)$/i;

/** True for Markdown file paths (by extension). */
export function isMarkdownPath(p: string): boolean {
  return MD_EXT.test(p);
}

/** Effective preference: default `ashlr-md`; only `editor` opts out. */
export function markdownOpenerPref(cfg: { markdownOpener?: unknown }): MarkdownOpenerPref {
  return cfg.markdownOpener === 'editor' ? 'editor' : 'ashlr-md';
}

/** Build the Ashlr MD deep link for an absolute path. */
export function ashlrMdDeepLink(path: string, mode: 'read' | 'edit' = 'read'): string {
  const abs = /^([A-Za-z]:)?[\\/]/.test(path) || isAbsolute(path) ? path : resolve(path);
  const q = `path=${encodeURIComponent(abs)}`;
  return `mdopener://open?${q}${mode === 'edit' ? '&mode=edit' : ''}`;
}

export interface DetectDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (p: string) => boolean;
}

/** Candidate install locations for Ashlr MD (app bundle or `mdopen` CLI). */
export function ashlrMdCandidates(deps: DetectDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const out: string[] = [];
  const cli = platform === 'win32' ? ['mdopen.exe', 'mdopen.cmd'] : ['mdopen'];
  for (const dir of (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (dir) for (const c of cli) out.push(join(dir, c));
  }
  if (platform === 'darwin') {
    out.push('/Applications/Ashlr MD.app', join(home, 'Applications', 'Ashlr MD.app'));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    out.push(join(local, 'Programs', 'Ashlr MD', 'Ashlr MD.exe'), join(local, 'Ashlr MD', 'Ashlr MD.exe'));
    if (env.ProgramFiles) out.push(join(env.ProgramFiles, 'Ashlr MD', 'Ashlr MD.exe'));
  } else {
    out.push('/usr/bin/md-opener', '/usr/bin/ashlr-md', '/usr/share/applications/Ashlr MD.desktop',
      join(home, '.local', 'share', 'applications', 'Ashlr MD.desktop'));
  }
  return out;
}

/** Best-effort: is Ashlr MD installed on this machine? (`PHANTOM_ASHLR_MD=0|1` overrides.) */
export function isAshlrMdInstalled(deps: DetectDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if (env.PHANTOM_ASHLR_MD === '0') return false;
  if (env.PHANTOM_ASHLR_MD === '1') return true;
  const exists = deps.exists ?? existsSync;
  return ashlrMdCandidates(deps).some((p) => {
    try { return exists(p); } catch { return false; }
  });
}

export type MarkdownOpenPlan =
  | { kind: 'ashlr-md'; url: string }
  | { kind: 'fallback'; reason: 'not-markdown' | 'opted-out' | 'not-installed' };

/** Decide how to open `path`. Pure given deps. */
export function planMarkdownOpen(
  path: string,
  cfg: { markdownOpener?: unknown },
  deps: DetectDeps = {},
): MarkdownOpenPlan {
  if (!isMarkdownPath(path)) return { kind: 'fallback', reason: 'not-markdown' };
  if (markdownOpenerPref(cfg) === 'editor') return { kind: 'fallback', reason: 'opted-out' };
  if (!isAshlrMdInstalled(deps)) return { kind: 'fallback', reason: 'not-installed' };
  return { kind: 'ashlr-md', url: ashlrMdDeepLink(path) };
}

/** One-line install offer shown when a Markdown file falls back to the editor. */
export function ashlrMdInstallHint(platform: NodeJS.Platform = process.platform): string {
  const how = platform === 'darwin'
    ? `download the .dmg from ${ASHLR_MD_RELEASES}`
    : platform === 'win32'
      ? `download the .msi/.exe from ${ASHLR_MD_RELEASES}`
      : `install the .deb/.rpm/.AppImage from ${ASHLR_MD_RELEASES}`;
  return `Tip: Phantom opens Markdown in Ashlr MD when installed — ${how}. `
    + `Opt out with "markdownOpener": "editor" in your Phantom config.`;
}
