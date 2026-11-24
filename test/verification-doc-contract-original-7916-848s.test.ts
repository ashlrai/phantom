import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const section = (text: string, start: string, end: string) => {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  return text.slice(first, last);
};

describe('original #7916 contributor verification contract', () => {
  const agents = section(read('AGENTS.md'), '## Working in this repository', '- When authority drift fails');
  const claude = section(read('CLAUDE.md'), '## Commands', '## Companion tools');
  const contributing = read('CONTRIBUTING.md');
  const local = section(contributing, 'Use `node scripts/verify-changed.mjs` after editing', 'When the diff changes a markdown');
  const hosted = section(contributing, '### What Merge Gate requires', '### Updating a pull request');

  for (const [name, text] of [['AGENTS', agents], ['CLAUDE', claude], ['CONTRIBUTING', local]] as const) {
    it(`${name} separates local verification from hosted and scheduled checks`, () => {
      expect(text).toMatch(/(?:do not|does not) replace (?:the (?:required hosted )?)?`?Merge Gate`?/i);
      expect(text).toMatch(/(?:pull request|PR).*fast gate/i);
      expect(text).toMatch(/(?:full (?:backend, Windows and macOS )?suites).*scheduled `master`/i);
      expect(text).not.toMatch(/verify-changed(?:\.mjs)?`?[^.]{0,100}\b(?:runs?|executes?) (?:the )?(?:affected|selected) tests/i);
      expect(text).not.toMatch(/(?:local checks|verify-changed(?:\.mjs)?`?)\s+(?:replace|supersede) (?:the )?(?:required |hosted )?`?Merge Gate/i);
    });
  }

  it('requires affected tests separately from the local checker', () => {
    expect(agents).toMatch(/also run .*affected tests/i);
    expect(claude).toMatch(/also run .*affected tests/i);
    expect(local).toMatch(/does not run the affected test suites; run those separately/i);
    expect(local).toMatch(/can run authority drift tests when master has moved/i);
  });

  it('describes the required PR gate and its selected tests', () => {
    for (const text of [agents, hosted]) {
      expect(text).toMatch(/secret/i);
      expect(text).toMatch(/generated[ -]files?/i);
      expect(text).toMatch(/fast gate.*type\s*check.*(?:tests selected|affected tests)/i);
    }
    expect(hosted).toMatch(/pull requests and merge.queue/i);
  });
});
