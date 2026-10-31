import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

const scripts = [
  'lane-utilization.ts',
  'personal-usage-follow.ts',
  'harness-bet-overlap.ts',
  'harness-citation-pack.ts',
  'inbox-prompt-export.ts',
  'channel-ack-replay.ts',
];

describe('usage, harness and inbox example companions', () => {
  for (const script of scripts) {
    const base = script.replace('.ts', '');
    const mdPath = resolve(repoRoot, 'examples', 'agents', `${base}.md`);
    const tsPath = resolve(repoRoot, 'examples', 'agents', script);

    it(`${base}: companion .md exists`, () => {
      expect(() => readFileSync(mdPath, 'utf-8')).not.toThrow();
    });

    it(`${base}: companion contains runnable npx tsx line`, () => {
      const md = readFileSync(mdPath, 'utf-8');
      expect(md).toContain(`npx tsx examples/agents/${script}`);
    });

    it(`${base}: all --flag tokens in .md appear in source`, () => {
      const md = readFileSync(mdPath, 'utf-8');
      const flags = md.match(/--[a-z][a-z-]*/g) ?? [];
      const ts = readFileSync(tsPath, 'utf-8');
      for (const flag of flags) {
        expect(ts).toContain(flag);
      }
    });
  }
});
