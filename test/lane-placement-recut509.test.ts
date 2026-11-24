import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

it.each([
  'contrib.mac.tests.test_lane_placement',
  'contrib.mac.tests.test_process_snapshot_cpu',
  'contrib.mac.tests.test_process_snapshot',
])('preserves the Python regression assertions in %s', (suite) => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', suite], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/Ran \d+ tests?/);
  expect(result.stderr).toMatch(/\nOK\s*$/);
});
