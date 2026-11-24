import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const guide = readFileSync(resolve(root, 'CONTRIBUTING.md'), 'utf8');

describe('PR #7474 contributor reference preservation', () => {
  it('names existing adversarial suites for the safety invariants', () => {
    expect(guide).toContain('## Safety invariants contributors must never weaken');
    const invariants = guide.split('## Safety invariants contributors must never weaken')[1]
      ?.split('\n---')[0] ?? '';
    for (const path of [
      'test/h4.sandbox-enrollment-kill.test.ts',
      'test/h6.audit-completeness.test.ts',
      'test/h1.daemon-gates.test.ts',
      'test/m48.fleet-supervisor.test.ts',
      'test/m45.foundry.test.ts',
      'test/h1.chain.test.ts',
      'test/h1.apply-guardrails.test.ts',
    ]) {
      expect(invariants, path).toContain('`' + path + '`');
      expect(readFileSync(resolve(root, path), 'utf8'), path).toMatch(/\b(?:it|test)\(/);
    }
    expect(invariants).toContain('`allowAnyRepo` cannot override it');
    expect(invariants).toContain('a refused apply mutates nothing');
  });

  it('includes the additional existing source areas in the project map', () => {
    const layout = guide.split('## Project layout')[1] ?? '';
    for (const area of ['mcp', 'fleet', 'shared', 'doctor', 'planning']) {
      expect(layout, area).toContain(area + '/');
      expect(statSync(resolve(root, 'src', area)).isDirectory(), area).toBe(true);
    }
    expect(layout).toContain('[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)');
    expect(readFileSync(resolve(root, 'llms.txt'), 'utf8')).toMatch(/^# Phantom\n/);
  });
});
