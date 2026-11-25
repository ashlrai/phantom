import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the hermetic fleet profile regression suite', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'fleet.tests.test_profile'], { cwd, encoding: 'utf8', timeout: 25_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/\nOK\s*$/);
}, 30_000);
