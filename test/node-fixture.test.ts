import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFixtureHeader } from './helpers/node-fixture.js';

describe('node fixture header', () => {
  it('executes the same payload and preserves arguments and process identity with a quoted runtime path', async () => {
    const root = mkdtempSync(join(tmpdir(), "node's fixture "));
    try {
      const node = join(root, "node's runtime");
      const fixture = join(root, 'fixture');
      symlinkSync(process.execPath, node);
      writeFileSync(fixture, nodeFixtureHeader(node) + 'console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));\n', { mode: 0o700 });
      const before = readFileSync(fixture);
      const child = spawn(fixture, ['a b', "c'd", '$(false)', '']);
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { output += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({ pid: child.pid, args: ['a b', "c'd", '$(false)', ''] });
      expect(readFileSync(fixture)).toEqual(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['\n', '\r', '\u2028', '\u2029', '\0'])('rejects a path containing %j', char => {
    expect(() => nodeFixtureHeader(`/node${char}path`)).toThrow('Invalid Node fixture path');
  });
});
