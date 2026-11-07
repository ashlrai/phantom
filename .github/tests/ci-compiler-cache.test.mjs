import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));

test('real incremental compiler rechecks changed source and dependency contracts', { timeout: 60_000 }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-ci-compiler-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'state.tsbuildinfo');
  const config = { compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, skipLibCheck: true, types: [], noEmit: true, incremental: true, tsBuildInfoFile: cache }, include: ['*.ts'] };
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify(config));
  writeFileSync(join(root, 'value.ts'), 'export const value: number = 1;\n');
  writeFileSync(join(root, 'consumer.ts'), "import { value } from './value.js';\nexport const result: number = value;\n");
  const run = (expected, diagnostic) => {
    const result = spawnSync(process.execPath, [compiler, '--noEmit', '-p', join(root, 'tsconfig.json')],
      { cwd: root, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, expected, result.stdout + result.stderr);
    if (diagnostic) assert.match(result.stdout + result.stderr, diagnostic);
  };
  run(0);
  assert.ok(existsSync(cache));
  run(0); // Reuse the exact successful graph, without treating its existence as success.
  writeFileSync(join(root, 'value.ts'), 'export const value: number = "invalid";\n');
  run(2, /TS2322/);
  writeFileSync(join(root, 'value.ts'), 'export const value: number = 1;\n');
  run(0);
  // The unchanged consumer must be invalidated by a changed imported contract.
  writeFileSync(join(root, 'value.ts'), 'export const value: string = "changed";\n');
  run(2, /TS2322/);
  rmSync(cache);
  run(2, /TS2322/); // A missing cache still runs the full compiler and finds the error.
});
