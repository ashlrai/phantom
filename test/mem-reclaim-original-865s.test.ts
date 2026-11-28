import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('original reclaim documentation', () => {
  it('binds the historical proposal to its source and absent entry point', () => {
    const doc = read('docs/MEM-RECLAIM.md');
    expect(doc).toMatch(/## Implemented status[\s\S]*phm mem reclaim[\s\S]*absent/);
    expect(doc).toContain('historical, not executable instructions');
    expect(doc).toContain('https://github.com/ashlrai/phantom/pull/5803');
    expect(doc).toContain('e6a6ec04cc2ef14607fdde1819ee417f2c9702cb');
    for (const name of ['idle-model', 'orphaned-process', 'job-leftover']) expect(doc).toContain(name);
    expect(existsSync('src/cli/mem.ts')).toBe(false);
    expect(existsSync('src/core/memory/reclaim.ts')).toBe(false);
  });

  it('ties the advertised inspection command to the CLI routing and flags', () => {
    const doc = read('docs/MEM-RECLAIM.md');
    const registry = read('src/cli/fleet-subcommand-registry.ts');
    const fleet = read('src/cli/fleet.ts');
    const cli = read('src/cli/fleet-memory.ts');
    expect(doc).toMatch(/```sh\nphm fleet memory --json\n```/);
    expect(JSON.parse(read('package.json')).bin.phm).toBe('bin/ashlr');
    expect(read('src/cli/index.ts')).toMatch(/cmdFleet\(rest\)/);
    expect(registry).toMatch(/'memory':\s*\(\) => import\('\.\/fleet-memory\.js'\)/);
    expect(fleet).toContain('resolveFleetSubcommand(sub)');
    expect(fleet).toContain('fn(rest)');
    expect(cli).toContain('export async function cmdFleetMemory');
    expect(cli).toContain("['--json', '--root'].includes(arg)");
    expect(cli).toContain("if (arg === '--json') json = true");
  });
});
