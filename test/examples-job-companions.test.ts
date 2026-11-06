import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const EXAMPLES_DIR = join(__dirname, '..', 'examples', 'agents');

const COMPANIONS = [
  { name: 'job-batch-status' },
  { name: 'job-edit-collisions' },
  { name: 'job-notes-to-bus' },
  { name: 'job-pair-compare' },
];

describe('job inspection example companions', () => {
  for (const { name } of COMPANIONS) {
    const mdPath = join(EXAMPLES_DIR, `${name}.md`);
    const tsPath = join(EXAMPLES_DIR, `${name}.ts`);
    const mdContent = readFileSync(mdPath, 'utf-8');
    const tsContent = readFileSync(tsPath, 'utf-8');

    it(`${name}.md exists and is readable`, () => {
      expect(mdContent.length).toBeGreaterThan(0);
    });

    it(`${name}.md contains the runnable npx tsx line`, () => {
      expect(mdContent).toMatch(
        new RegExp(`npx tsx examples/agents/${name}\\.ts`),
      );
    });

    it(`${name}.md flags all appear in the .ts source`, () => {
      const flagPattern = /--[a-z][a-z-]*/g;
      const flags = new Set(
        mdContent.match(flagPattern) ?? [],
      );
      for (const flag of flags) {
        expect(tsContent).toContain(flag);
      }
    });
  }
});
