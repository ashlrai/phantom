/**
 * core/markdown-opener.ts — Ashlr MD as Phantom's out-of-box Markdown opener.
 *
 * When Phantom opens a Markdown file (CLI `phantom open`, the web/desktop
 * `POST /api/open`), it prefers Ashlr MD (https://github.com/ashlrai/ashlr-md)
 * via its `mdopener://open?path=…` URL scheme. If Ashlr MD is not installed,
 * or the user opts out with `"markdownOpener": "editor"` in config, the
 * existing editor deep link is used as a graceful fallback.
 *
 * Detection and URL building are pure / injectable so they test on any host.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

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
