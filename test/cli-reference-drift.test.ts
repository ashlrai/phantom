import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdHelp } from '../src/cli/help.js';
import { renderCliReference } from '../scripts/generate-cli-reference.js';

afterEach(() => vi.restoreAllMocks());

describe('generated CLI reference', () => {
  it('matches the current overview and complete command help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const capture = async (args: string[]): Promise<string> => {
      log.mockClear();
      expect(await cmdHelp(args)).toBe(0);
      return log.mock.calls.map(args => args.map(String).join(' ')).join('\n') + '\n';
    };
    const summary = await capture([]);
    const commands = await capture(['--all']);
    const actual = readFileSync(new URL('../docs/CLI-REFERENCE.md', import.meta.url), 'utf8');
    expect(actual, 'Run node --import tsx scripts/generate-cli-reference.ts').toBe(
      renderCliReference(summary, commands),
    );
  });

  it('normalizes terminal formatting without dropping command options', () => {
    const rendered = renderCliReference('\u001b[1mPhantom\u001b[0m \u2014 help  \r\n', '  run --json  \r\n');
    expect(rendered).toContain('Phantom - help\n');
    expect(rendered).toContain('run --json\n');
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toMatch(/[\u2014\r]/);
  });
});
