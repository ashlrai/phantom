import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strictEqual } from 'node:assert';

const EXAMPLES_DIR = resolve(import.meta.dirname, '..', 'examples', 'agents');

const SCRIPTS = [
  'bus-fanout',
  'bus-gather',
  'bus-backlog-drain',
  'bus-notes-context',
];

async function readText(name: string): Promise<string> {
  return readFile(resolve(EXAMPLES_DIR, `${name}.md`), 'utf8');
}

async function readSource(name: string): Promise<string> {
  return readFile(resolve(EXAMPLES_DIR, `${name}.ts`), 'utf8');
}

function findFlags(md: string): Set<string> {
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const re = /--([a-z][a-z-]*)/g;
  while ((match = re.exec(md)) !== null) {
    found.add(`--${match[1]}`);
  }
  return found;
}

describe('agent bus example companions', () => {
  for (const name of SCRIPTS) {
    const mdPath = `${name}.md`;
    const tsPath = `${name}.ts`;
    const exampleLine = `npx tsx examples/agents/${name}.ts`;

    it(`${mdPath} exists`, async () => {
      await readText(name);
    });

    it(`${mdPath} contains the example invocation line`, async () => {
      const md = await readText(name);
      strictEqual(md.includes(exampleLine), true, `${mdPath} must contain '${exampleLine}'`);
    });

    it(`${mdPath} flags all appear in ${tsPath}`, async () => {
      const md = await readText(name);
      const ts = await readSource(name);
      const flags = findFlags(md);
      for (const flag of flags) {
        strictEqual(
          ts.includes(flag),
          true,
          `${mdPath} references '${flag}' but ${tsPath} does not contain it`,
        );
      }
    });
  }
});
