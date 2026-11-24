import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const path = resolve(root, 'docs/AGENTS-MD-AUDIT.md');
const read = (name: string): string => readFileSync(resolve(root, name), 'utf8');
const audit = readFileSync(path, 'utf8');

describe('docs recovery from PR #7946', () => {
  it('preserves the dated seven-repository refresh and distinguishes historical gaps', () => {
    expect(existsSync(path)).toBe(true);
    expect(audit).toContain('Public-source snapshot: 2026-11-21');
    expect(audit).toContain('not current checkout state');
    expect(audit).toContain('not official readiness scores');
    expect(audit).toContain('scripts/agent-readiness/score.mjs');
    expect(existsSync(resolve(root, 'scripts/agent-readiness/score.mjs'))).toBe(true);
    expect(read('src/core/observability/agent-readiness.ts')).toContain('agentsMd: scoreAgentsMd');
  });

  it('resolves every relative Markdown link in the recovered guide', () => {
    const links = [...audit.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
      .map((match) => match[1]!)
      .filter((link) => !/^[a-z][a-z\d+.-]*:/i.test(link));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const target = decodeURIComponent(link.split('#')[0]!);
      expect(existsSync(resolve(dirname(path), target)), link).toBe(true);
    }
  });

  it('keeps named Phantom commands dispatched and promotion arguments complete', () => {
    const dispatch = read('src/cli/index.ts');
    const improve = read('src/cli/improve.ts');
    const commands = [...audit.matchAll(/`phm ([^`]+)`/g)].map((match) => match[1]!);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const [top, verb] = command.split(/\s+/);
      expect(dispatch, command).toContain(`case '${top}':`);
      if (verb && !verb.startsWith('--')) {
        expect(improve, command).toContain(`case '${verb}':`);
      }
    }
    expect(audit).toContain('phm improve propose --auto-merge');
    expect(improve).toContain("if (args.includes('--auto-merge'))");
    expect(audit).toContain('phm improve promote <id> --repo <dir> --queue-merge');
    expect(improve).toContain("val('--repo')");
    expect(improve).toContain("args.includes('--queue-merge')");
  });
});
