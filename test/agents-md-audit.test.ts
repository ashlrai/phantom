import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const agents = read('AGENTS.md');
const audit = read('docs/AGENTS-MD-AUDIT.md');
const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string>; engines: { node: string } };

function missingScripts(text: string, scripts: Record<string, string>): string[] {
  const commands = [...text.matchAll(/\bnpm run ([\w:-]+)/g)].map((match) => match[1]!);
  if (/\bnpm test\b/.test(text)) commands.push('test');
  return [...new Set(commands)].filter((name) => !Object.hasOwn(scripts, name));
}

describe('AGENTS.md contributor command contract', () => {
  it('keeps every documented npm script and Node requirement aligned with the manifest', () => {
    expect(missingScripts(agents, manifest.scripts)).toEqual([]);
    expect(agents).toContain(`Node \`${manifest.engines.node}\``);
    for (const name of ['build', 'test:ci', 'typecheck', 'lint', 'check:docs', 'test:web']) {
      expect(agents).toContain(`npm run ${name}`);
    }
  });

  it('detects deleted scripts, typos and missing npm test aliases', () => {
    const scripts = { ...manifest.scripts };
    delete scripts['build'];
    expect(missingScripts(agents, scripts)).toEqual(['build']);
    expect(missingScripts('`npm run typo` and `npm test`', {})).toEqual(['typo', 'test']);
    expect(missingScripts('`npm run test:ci -- test/example.test.ts`', { 'test:ci': 'vitest run' })).toEqual([]);
  });

  it('preserves seven independently cited score rows with correct arithmetic', () => {
    const rows = audit.split('\n').filter((line) => /^\| (?:phantom|locus|lexicon|ashlr-)/.test(line));
    const expected = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-plugin', 'ashlr-md'];
    expect(rows.map((row) => row.split('|')[1]!.trim())).toEqual(expected);
    for (const row of rows) {
      const cells = row.split('|').map((cell) => cell.trim());
      const vector = cells[2]!.split('/').map(Number);
      expect(vector).toHaveLength(8);
      expect(vector.every((point) => point === 0 || point === 1)).toBe(true);
      expect(cells[3]).toBe(`${vector.reduce((sum, point) => sum + point, 0)}/8`);
      expect(cells[4]).toMatch(new RegExp(`https://github.com/ashlrai/${cells[1]}/blob/[a-f0-9]{40}/AGENTS\\.md#L\\d+-L\\d+`));
      expect(cells[5]!.length).toBeGreaterThan(80);
    }
    expect(audit).toContain('Official rubric scores are unavailable');
    expect(audit).toContain('not official readiness scores');
  });

  it('keeps the changed instructions and audit free of em dashes', () => {
    expect(agents + audit).not.toContain('\u2014');
  });
});
