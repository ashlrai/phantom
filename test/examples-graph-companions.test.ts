import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = resolve(__dirname, '..');
const FLAG_RE = /--[a-z][a-z-]*/g;

const SCRIPTS = [
  { name: 'graph-delegation-path', ts: 'examples/agents/graph-delegation-path.ts', md: 'examples/agents/graph-delegation-path.md' },
  { name: 'graph-review-candidates', ts: 'examples/agents/graph-review-candidates.ts', md: 'examples/agents/graph-review-candidates.md' },
  { name: 'task-frontier', ts: 'examples/agents/task-frontier.ts', md: 'examples/agents/task-frontier.md' },
  { name: 'task-wave-plan', ts: 'examples/agents/task-wave-plan.ts', md: 'examples/agents/task-wave-plan.md' },
];

function extractFlags(md: string): Set<string> {
  const matches = md.match(FLAG_RE);
  return new Set(matches ?? []);
}

describe('graph orchestration example companions', () => {
  for (const { name, ts, md } of SCRIPTS) {
    const tsPath = resolve(BASE, ts);
    const mdPath = resolve(BASE, md);

    it(`${md} exists`, () => {
      expect(readFileSync(mdPath, 'utf8')).toBeDefined();
    });

    it(`${md} contains a runnable npx tsx line`, () => {
      const content = readFileSync(mdPath, 'utf8');
      const expected = `npx tsx examples/agents/${name}.ts`;
      expect(content).toContain(expected);
    });

    it(`${md} --flag tokens appear in the .ts source`, () => {
      const mdContent = readFileSync(mdPath, 'utf8');
      const tsContent = readFileSync(tsPath, 'utf8');
      const flags = extractFlags(mdContent);
      for (const flag of flags) {
        expect(tsContent).toContain(flag);
      }
    });
  }
});
