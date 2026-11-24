import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const paths = ['docs/llms-source.txt', 'docs/llms.txt'];
const prefixes = ['- [Team org]', '- [Team invite, join and remove]', '- Dispatcher admission:'];
const carried = (text: string) => text.split('\n').filter(line => prefixes.some(prefix => line.startsWith(prefix)));

describe('PR #7088 documentation preservation', () => {
  it('preserves all three entries in both the source and generated index', () => {
    const entries = carried(read(paths[0]!));
    expect(entries).toHaveLength(3);
    expect(carried(read(paths[1]!))).toEqual(entries);
    expect(entries[0]).toContain('--member <id> --machine <id>');
    expect(entries[1]).toContain('Agent processes are refused');
    expect(entries[2]).toContain('Unavailable evidence stays unknown');
  });

  it('keeps every relative link in the landed indexes resolvable on disk', () => {
    for (const path of paths) {
      expect(existsSync(resolve(root, path)), path).toBe(true);
      for (const match of read(path).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (/^https?:/.test(target)) {
          const url = new URL(target);
          expect(url.username, target).toBe('');
          expect(url.password, target).toBe('');
          if (url.href.startsWith('https://github.com/ashlrai/phantom/blob/master/')) {
            expect(existsSync(resolve(root, decodeURIComponent(url.pathname.split('/blob/master/')[1]!))), target).toBe(true);
          }
          continue;
        }
        const file = target.split('#')[0]!;
        if (file) expect(existsSync(resolve(root, dirname(path), file)), target).toBe(true);
      }
    }
  });

  it('checks every carried phm verb against its dispatch handler', () => {
    const index = read('src/cli/index.ts');
    const handlers: Record<string, string> = {
      org: read('src/cli/org.ts'), team: read('src/cli/team.ts'), pool: read('src/cli/pool.ts'),
    };
    const invocations = [...carried(read(paths[0]!)).join('\n').matchAll(/`(?:ashlr|phm) ([\w-]+) ([\w|/-]+)[^`]*`/g)];
    expect(invocations).toHaveLength(5);
    for (const [, command, alternatives] of invocations) {
      expect(TOP_LEVEL_COMMANDS).toContain(command);
      expect(index).toContain(`case '${command}':`);
      for (const verb of alternatives!.split('|')) {
        // Require executable branch syntax, rather than a mention in help text.
        expect(handlers[command!], `${command} ${verb}`).toMatch(
          new RegExp(`case '${verb}':|(?:sub|verb|args\\[0\\]) (?:===|!==) '${verb}'|\\[[^\\n]*'${verb}'[^\\n]*\\]\\.includes`),
        );
      }
    }
  });
});
