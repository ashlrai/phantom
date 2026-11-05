import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const doc = readFileSync(new URL('../docs/COS.md', import.meta.url), 'utf8');

describe('docs/COS.md commands', () => {
  it('names only registered fleet verbs', () => {
    const verbs = [...doc.matchAll(/\bphm fleet ([a-z][a-z0-9-]*)/g)].map(match => match[1]!);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) expect(Object.keys(FLEET_SUBCOMMAND_LOADERS), verb).toContain(verb);
    for (const verb of ['cos', 'cos-work', 'cos-reconcile']) expect(verbs).toContain(verb);
  });

  it('does not document the top-level phm cos command', () => {
    const stale = doc.split('\n').filter(line => line.includes('phm cos ') && !/legacy/i.test(line));
    expect(stale).toEqual([]);
  });
});
