/**
 * changelog-read.ts — the "What's new" bullets for one released version, read
 * from the CHANGELOG.md that ships in the npm package (release-please format).
 * `changelogSection` is pure; `readInstalledChangelog` is the one fs read.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WHATS_NEW_MAX_BULLETS = 8;
const MAX_CHANGELOG_BYTES = 8 * 1024 * 1024;
const MAX_BULLET_CHARS = 280;

export const WHATS_NEW_VERSION = /^\d+\.\d+\.\d+$/;

/**
 * "[text](url)" → "text"; trailing "(#123)" and "([abc1234](url))" references
 * dropped; "**scope:**" emphasis unwrapped, since the card renders plain text
 * and would otherwise show literal asterisks.
 */
function cleanBullet(raw: string): string {
  return raw
    .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/gi, '')
    .replace(/\s*\(\[#\d+\]\([^)]*\)\)/g, '')
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BULLET_CHARS);
}

/** The bullets under `## [version]` / `## version`, or null when that exact version has no entry. */
export function changelogSection(markdown: string, version: string): string[] | null {
  if (!WHATS_NEW_VERSION.test(version)) return null;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const m = /^##\s+\[?(\d+\.\d+\.\d+)\]?(?:\s|\(|$)/.exec(line);
    return m !== null && m[1] === version;
  });
  if (start < 0) return null;
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^\s*[*-]\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const bullet = cleanBullet(m[1]!);
    if (bullet) bullets.push(bullet);
    if (bullets.length >= WHATS_NEW_MAX_BULLETS) break;
  }
  return bullets;
}

/** Nearest ancestor of this module holding a package.json (dist/ or src/ layouts both resolve). */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Missing or unreadable CHANGELOG.md, or no entry for `version` → null. */
export function readInstalledChangelog(version: string, root: string | null = packageRoot()): string[] | null {
  if (root === null || !WHATS_NEW_VERSION.test(version)) return null;
  try {
    const file = join(root, 'CHANGELOG.md');
    if (statSync(file).size > MAX_CHANGELOG_BYTES) return null;
    return changelogSection(readFileSync(file, 'utf8'), version);
  } catch { return null; }
}
