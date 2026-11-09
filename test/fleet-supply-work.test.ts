import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRestockDocument } from '../src/core/portfolio/restock-lint.js';
import { planSupply, readRoadmap, readTodos } from '../src/core/fleet/supply.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

describe('fleet supply work', () => {
  it('deduplicates queue titles and emits parseable READY lines', () => {
    const queue = readFileSync('test/fixtures/fleet-supply/queue.md', 'utf8');
    const lines = planSupply([
      { title: 'Fix the first bug', source: 'src/a.ts:1' },
      { title: 'Fix the second bug', source: 'src/b.ts:2' },
      { title: 'Fix the second bug.', source: 'src/c.ts:3' },
      { title: 'Fix the third bug', source: 'ROADMAP.md:3' },
    ], queue, 'codex-personal', 5);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^- READY RQ-[\w-]+ \(P1, pool=codex-personal, tier=work, repo=phantom, size<=200\): .+ Acceptance: .+/);
    const report = lintRestockDocument(lines.join('\n'), { isDir: () => true });
    expect(report.accepted).toHaveLength(2);
    expect(report.drops).toEqual([]);
    expect(planSupply([{ title: 'Fix the second bug', source: 'src/b.ts:2' }], lines.join('\n'), 'codex-personal', 1)).toEqual([]);
  });
  it('reads unchecked roadmap items and real TODO comment lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'supply-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'ROADMAP.md'), '- [ ] Do the thing\n- [x] Done\n');
    writeFileSync(join(root, 'src', 'a.ts'), '// TODO(owner): Fix a thing\nconst s = "// TODO(owner): fake";\n');
    expect(await readRoadmap(root)).toEqual([{ title: 'Do the thing', source: 'ROADMAP.md:1' }]);
    expect(await readTodos(root)).toEqual([{ title: 'Fix a thing', source: 'src/a.ts:1' }]);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS.supply!()).cmdFleetSupply).toBe('function');
  });
});
