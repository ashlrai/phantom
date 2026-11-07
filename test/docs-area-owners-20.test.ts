import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const doc = readFileSync(resolve(root, 'docs/AREA-OWNERS.md'), 'utf8');
const paths = (text: string): string[] => [...text.matchAll(/`((?:src|test|docs|scripts)\/[^`]+)`/g)].map((match) => match[1]);
const patterns = readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8')
  .split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  .map((line) => line.split(/\s+/)[0]);

function matches(pattern: string, path: string): boolean {
  const glob = pattern.replace(/^\//, '');
  let regex = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; regex += '(?:.*/)?'; } else regex += '.*';
      } else regex += '[^/]*';
    } else regex += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${regex}$`).test(path);
}

describe('area owner map', () => {
  it('references existing paths with the right directory type', () => {
    const listed = paths(doc);
    expect(listed.length).toBeGreaterThan(0);
    for (const path of listed) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
      if (path.endsWith('/')) expect(statSync(resolve(root, path)).isDirectory(), path).toBe(true);
    }
  });

  it('marks only CODEOWNERS paths as owner-only', () => {
    const lines = doc.split('\n').filter((line) => line.startsWith('**Owner-only paths:**'));
    expect(lines).toHaveLength(10);
    const owned = lines.flatMap(paths);
    expect(owned.length).toBeGreaterThan(0);
    for (const path of owned) expect(patterns.some((pattern) => matches(pattern, path)), path).toBe(true);
  });

  it('covers all ten areas', () => {
    for (const heading of ['Comms intake (email, Telegram, iMessage)', 'Channel envelope, dedupe and acks', 'Leader thread (Mason ↔ Leader)', 'Chief of staff', 'Agent bus', 'Fleet CLI verbs', 'Desktop Verse console panes', 'Remote/phone gateway', 'Usage and accounts', 'Release and self-update']) {
      expect(doc).toContain(`## ${heading}\n`);
    }
  });
});
