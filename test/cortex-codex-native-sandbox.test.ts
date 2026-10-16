import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CORTEX_CODEX_PERMISSION_CONFIG, CORTEX_CODEX_PERMISSION_PROFILE } from '../src/core/cortex/codex-policy.js';

const codexAvailable = process.platform === 'darwin' && spawnSync('codex', ['--version'], { timeout: 5000 }).status === 0;

it.skipIf(!codexAvailable)('native Codex workspace sandbox denies direct TCP and writes outside its root without inference or provider credentials', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-codex-native-')));
  const workspace = join(root, 'workspace'); const nativeHome = join(root, 'native-home');
  mkdirSync(workspace); mkdirSync(nativeHome);
  const probe = `touch inside.txt || exit 8
    outside=false
    if touch "$1" 2>outside.log; then outside=false; else outside=true; fi
    network=false
    if /usr/bin/nc -G 2 -z -v 1.1.1.1 443 2>network.log; then network=false
    elif /usr/bin/grep -qi 'operation not permitted' network.log; then network=true; fi
    printf '{"inside":true,"outsideDenied":%s,"networkDenied":%s}\\n' "$outside" "$network"`;
  try {
    const result = spawnSync('codex', ['sandbox', '--permissions-profile', CORTEX_CODEX_PERMISSION_PROFILE, '-C', workspace,
      '-c', CORTEX_CODEX_PERMISSION_CONFIG, '/bin/sh', '-c', probe, 'probe', join(root, 'outside.txt')], {
      cwd: workspace, encoding: 'utf8', timeout: 10_000, env: { ...process.env, CODEX_HOME: nativeHome },
    });
    expect(result.stderr).not.toContain('unknown'); expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()), readFileSync(join(workspace, 'network.log'), 'utf8')).toEqual({ inside: true, outsideDenied: true, networkDenied: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
