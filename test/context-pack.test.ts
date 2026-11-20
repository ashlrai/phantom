import { describe, expect, it } from 'vitest';
import { cmdContextPack } from '../src/cli/context-pack.js';

const files = ['src/core/billing/invoice.ts', 'src/core/inbox/merge.ts', 'src/cli/inbox.ts', 'README.md', 'node_modules/invoice/index.js'];
const reference = [
  '| <code>phm inbox merge [--json]</code> | Merge ready pulls from the inbox. | <code>--json</code> | <code>phm inbox merge</code> |',
  '| <code>phm status</code> | Show fleet status. | | |',
].join('\n');
const titles = ['bridge(RQ-X): inbox merge queue wait (#1)', 'docs: unrelated change (#2)'];

function run(goal: string, extra: string[] = []) {
  let text = '';
  const code = cmdContextPack([goal, ...extra], { cwd: '/nowhere', files: () => files, titles: () => titles, reference: () => reference, out: s => { text = s; } });
  return { code, text };
}

describe('phm context pack', () => {
  it('ranks a file that matches the goal, skipping node_modules', () => {
    const { code, text } = run('fix invoice totals', ['--json']);
    const pack = JSON.parse(text);
    expect(code).toBe(0);
    expect(pack.schema).toBe('phantom.context-pack.v1');
    expect(pack.verdict).toBe('found');
    expect(pack.files.map((f: { path: string }) => f.path)).toEqual(['src/core/billing/invoice.ts']);
  });

  it('matches a command, related files, and a possibly-done title', () => {
    const { text } = run('speed up inbox merge', ['--json']);
    const pack = JSON.parse(text);
    expect(pack.commands[0]).toContain('phm inbox merge');
    expect(pack.files[0].path).toBe('src/core/inbox/merge.ts');
    expect(pack.possiblyDone).toEqual([titles[0]]);
  });

  it('says unknown when nothing matches', () => {
    const { code, text } = run('zebra quantum');
    expect(code).toBe(0);
    expect(text).toContain('unknown');
    expect(JSON.parse(run('zebra quantum', ['--json']).text).verdict).toBe('unknown');
  });

  it('stays under 4 KB and honors --max-files', () => {
    const many = Array.from({ length: 400 }, (_, i) => `src/inbox/merge-${i}-${'x'.repeat(40)}.ts`);
    let text = '';
    cmdContextPack(['inbox merge'], { files: () => many, titles: () => [], reference: () => reference, out: s => { text = s; } });
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
    let json = '';
    cmdContextPack(['inbox merge', '--max-files', '2', '--json'], { files: () => many, titles: () => [], reference: () => '', out: s => { json = s; } });
    expect(JSON.parse(json).files).toHaveLength(2);
  });

  it('rejects empty goals and bad --max-files with exit 2', () => {
    expect(cmdContextPack([], { out: () => {} })).toBe(2);
    expect(cmdContextPack(['x', '--max-files', '0'], { out: () => {} })).toBe(2);
  });
});
