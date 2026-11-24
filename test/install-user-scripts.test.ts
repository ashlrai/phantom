import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const powershell = readFileSync(join(root, 'scripts/install.ps1'), 'utf8');
const posix = readFileSync(join(root, 'scripts/install-release.sh'), 'utf8');

describe('per-user install scripts', () => {
  it('verify the npm tarball the same way the POSIX release installer does', () => {
    for (const script of [powershell, posix]) {
      expect(script).toContain('https://registry.npmjs.org');
      expect(script).toContain('@ashlr/phantom');
      expect(script).toContain('sha512-');
      expect(script).toContain('gh attestation verify');
      expect(script).toContain('--repo ashlrai/phantom');
      expect(script).toContain('phm doctor');
      expect(script).toContain('daemon install');
      expect(script).not.toMatch(/\/RU\s+SYSTEM|NT AUTHORITY\\SYSTEM|RunAs|Start-Process -Verb/);
      expect(script).not.toContain('—');
    }
  });

  it('keeps the Windows installer per-user and architecture-aware', () => {
    expect(powershell).toContain('OSArchitecture');
    expect(powershell).toContain('ashlr-windows-');
    expect(powershell).toContain("GetEnvironmentVariable('Path', 'User')");
    expect(powershell).toContain('Refusing to install as SYSTEM');
    expect(powershell).toContain('PHANTOM_TARBALL');
    expect(powershell).not.toMatch(/^\s*param\s*\(/m);
  });

  it('registers the Linux systemd --user daemon from the POSIX installer', () => {
    expect(posix).toContain('systemd --user');
    expect(posix).toContain("os_name\" = linux");
    expect(posix).toContain('uname -m');
    expect(posix).toContain('authority resident start');
  });

  it('exposes the same fail-closed verifier hook on each OS', () => {
    for (const script of [powershell, posix]) {
      expect(script).toContain('PHANTOM_VERIFY_RELEASE');
      expect(script).toContain('Release verifier refused the artifact');
      expect(script).toContain('Registry version mismatch');
      expect(script).toContain('Installed; doctor found setup items.');
    }
    expect(powershell.indexOf('Copy-Item -LiteralPath $Tarball')).toBeLessThan(powershell.indexOf('Test-Sha512 $downloaded $Integrity'));
    expect(powershell).toContain('$asset.browser_download_url -ceq $expectedAssetUrl');
    expect(powershell).toContain('Get-Command npm.cmd');
    expect(powershell).toContain('$got -cne $Expected');
    expect(powershell).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $Path');
    expect(powershell).toContain('PHANTOM_PATH_MODE');
  });
});
