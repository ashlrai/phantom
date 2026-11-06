import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('candidate documentation metadata', () => {
  it.each(['README.md', 'docs/QUICKSTART.md', 'desktop/README.md'])(
    '%s has exactly one candidate line for version synchronization', (file) => {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      // Keep identical to the documentation regex in scripts/sync-candidate-version.mjs.
      const candidateLine = /^(This source tree targets version )\d+\.\d+\.\d+(; check canonical release availability and exact matching assets before installation\.)$/gm;
      expect([...source.matchAll(candidateLine)]).toHaveLength(1);
    },
  );
});
