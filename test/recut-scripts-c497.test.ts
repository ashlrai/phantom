import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('desktop performance script help', () => {
  it('prints the usage documentation when invoked with --help', () => {
    const output = execFileSync(process.execPath, ['scripts/measure-desktop-perf.mjs', '--help'], {
      encoding: 'utf8',
    });
    expect(output).toContain('first meaningful render');
    expect(output).toContain('node scripts/measure-desktop-perf.mjs');
    expect(output).not.toContain('global setTimeout');
  });
});
