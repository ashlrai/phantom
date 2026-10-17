import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  authoritySetupPlatformRefusal,
  setupRefusalLead,
} from '../src/cli/first-run-guidance.js';

const BIN = resolve(__dirname, '..', 'bin', 'ashlr');

describe('setupRefusalLead', () => {
  it('tells a new user what to run instead of the background service', () => {
    const text = setupRefusalLead('linux').join('\n');
    expect(text).toContain('You do not need it to get started');
    expect(text).toContain('phm init');
    expect(text).toContain('phm doctor');
    expect(text).toContain('phm verse');
    expect(text).toContain('needs macOS');
  });

  it('points a Mac user at authority setup for unattended work', () => {
    const text = setupRefusalLead('darwin').join('\n');
    expect(text).toContain('run `phm authority setup` on this Mac');
    expect(text).not.toContain('needs macOS');
  });
});

describe('authoritySetupPlatformRefusal', () => {
  it('refuses a live setup off macOS with plain next steps', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const lines = authoritySetupPlatformRefusal(['setup'], platform);
      expect(lines).not.toBeNull();
      const text = lines!.join('\n');
      expect(text).toContain('needs macOS');
      expect(text).toContain(`This machine is ${platform}`);
      expect(text).toContain('Nothing was changed');
      expect(text).toContain('phm authority setup --dry-run');
    }
    expect(authoritySetupPlatformRefusal(['setup', '--yes'], 'linux')).not.toBeNull();
  });

  it('leaves macOS, the dry-run plan, help and other subcommands alone', () => {
    expect(authoritySetupPlatformRefusal(['setup'], 'darwin')).toBeNull();
    expect(authoritySetupPlatformRefusal(['setup', '--dry-run'], 'linux')).toBeNull();
    expect(authoritySetupPlatformRefusal(['setup', '--dry-run', '--json'], 'linux')).toBeNull();
    expect(authoritySetupPlatformRefusal(['setup', '--help'], 'linux')).toBeNull();
    expect(authoritySetupPlatformRefusal(['setup', '-h'], 'linux')).toBeNull();
    expect(authoritySetupPlatformRefusal(['status'], 'linux')).toBeNull();
    expect(authoritySetupPlatformRefusal([], 'linux')).toBeNull();
  });
});

describe.skipIf(process.platform === 'darwin')('ashlr authority setup off macOS (spawned)', () => {
  it('exits 1 with plain guidance and writes nothing to HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-authority-offmac-'));
    try {
      const r = spawnSync(process.execPath, [BIN, 'authority', 'setup'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
        input: '',
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('phm authority setup needs macOS');
      expect(r.stderr).toContain('phm init');
      expect(r.stdout).not.toContain('install-custody.sh');
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
