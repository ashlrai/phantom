import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The single optional Windows job executes the actual PowerShell entrypoint.
// Network and npm are inert fixtures; session PATH mode avoids registry writes.
describe('Windows release installer execution', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'phantom install [fixture] '));
    fixtures.push(dir);
    const home = join(dir, 'home [user]');
    const tools = join(dir, 'tools');
    const prefix = join(home, 'prefix [bin]');
    mkdirSync(home); mkdirSync(tools);
    const tarball = join(dir, 'package.tgz');
    writeFileSync(tarball, 'verified Windows package bytes');
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
    const helper = join(dir, 'tools.cjs');
    writeFileSync(helper, `
const fs = require('node:fs'), path = require('node:path');
const [tool, ...args] = process.argv.slice(2), dir = process.env.TEST_DIR;
fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({tool,args}) + '\\n');
if (tool === 'npm') {
  const prefix = args[args.indexOf('--prefix') + 1];
  fs.copyFileSync(args.at(-1), path.join(dir, 'installed.tgz'));
  fs.writeFileSync(path.join(prefix, 'phm.cmd'), '@echo off\\r\\n"%TEST_NODE%" "%TEST_HELPER%" phm %*\\r\\nexit /b %ERRORLEVEL%\\r\\n');
}
if (tool === 'phm' && args[0] === 'doctor') process.exit(Number(process.env.TEST_DOCTOR_EXIT || 0));
if (tool === 'verifier') process.exit(Number(process.env.TEST_VERIFY_EXIT || 0));
`);
    for (const name of ['npm', 'verifier']) writeFileSync(join(tools, `${name}.cmd`),
      `@echo off\r\n"%TEST_NODE%" "%TEST_HELPER%" ${name} %*\r\nexit /b %ERRORLEVEL%\r\n`);
    const metadata = { name: '@ashlr/phantom', version: '1.2.3', dist: {
      integrity, tarball: 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-1.2.3.tgz',
    } };
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod {
  param($Headers, [string]$Uri)
  if ($Uri.StartsWith('https://api.github.com/')) {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
    $name = "ashlr-windows-$arch.exe"
    return @{tag_name='v1.2.3';draft=$false;prerelease=$false;assets=@(@{
      name=$name;digest=('sha256:' + (Get-FileHash -LiteralPath $env:TEST_TARBALL -Algorithm SHA256).Hash);
      browser_download_url="https://github.com/ashlrai/phantom/releases/download/v1.2.3/$name"
    })}
  }
  return ([IO.File]::ReadAllText((Join-Path $env:TEST_DIR 'metadata.json')) | ConvertFrom-Json)
}
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  [IO.File]::Copy($env:TEST_TARBALL, $OutFile)
}
$before = [Environment]::GetEnvironmentVariable('Path', 'User')
try {
  & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:TEST_INSTALLER)))
} finally {
  if ([Environment]::GetEnvironmentVariable('Path', 'User') -cne $before) { throw 'Test changed the real user PATH' }
}
`;
    const run = (extra: Record<string, string> = {}) => {
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata));
      const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
      const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(harness, 'utf16le').toString('base64')], {
        env: { PATH: `${tools};${dirname(process.execPath)};${join(systemRoot, 'System32')}`,
          SystemRoot: systemRoot, ComSpec: join(systemRoot, 'System32', 'cmd.exe'), PATHEXT: '.COM;.EXE;.BAT;.CMD',
          HOME: home, USERPROFILE: home, USERNAME: 'phantom-fixture', LOCALAPPDATA: home, TMP: dir, TEMP: dir,
          TEST_DIR: dir, TEST_NODE: process.execPath, TEST_HELPER: helper, TEST_TARBALL: tarball,
          TEST_INSTALLER: join(root, 'scripts/install.ps1'), PHANTOM_PREFIX: prefix, PHANTOM_PATH_MODE: 'session', ...extra },
        encoding: 'utf8', timeout: 15_000,
      });
    };
    const events = (): Array<{ tool: string; args: string[] }> => existsSync(join(dir, 'events'))
      ? readFileSync(join(dir, 'events'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    return { dir, tools, prefix, tarball, integrity, metadata, run, events };
  }

  it('installs verified bytes into literal paths with spaces and brackets, then onboards', () => {
    const f = fixture();
    const result = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity, TEST_DOCTOR_EXIT: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.dir, 'installed.tgz'), 'utf8')).toBe('verified Windows package bytes');
    expect(f.events().filter(e => e.tool === 'phm').map(e => e.args)).toEqual([['--version'], ['doctor'], ['daemon', 'install']]);
    expect(result.stdout).toContain('doctor found setup items');
  });

  it('rejects a case-only change to the Base64 integrity before npm executes', () => {
    const f = fixture();
    const changed = f.integrity.slice(7).replace(/[a-zA-Z]/, char => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase());
    const result = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: 'sha512-' + changed });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release integrity verification failed');
    expect(f.events()).toEqual([]);
  });

  it('rejects a case-changed npm tarball path before download or installation', () => {
    const f = fixture(); f.metadata.dist.tarball = f.metadata.dist.tarball.replace('/phantom/-/', '/Phantom/-/');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release integrity metadata unavailable');
    expect(f.events()).toEqual([]);
  });

  it('stops on a rejected verifier and refuses drive-relative verifier paths', () => {
    const f = fixture();
    const result = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity,
      PHANTOM_VERIFY_RELEASE: join(f.tools, 'verifier.cmd'), TEST_VERIFY_EXIT: '9' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release verifier refused the artifact');
    expect(f.events().map(e => e.tool)).toEqual(['verifier']);
    const relative = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity, PHANTOM_VERIFY_RELEASE: 'C:verifier.cmd' });
    expect(relative.status).not.toBe(0);
    expect(relative.stderr).toContain('Release verifier must be an absolute executable path');
  });

  it('hashes native bytes and writes the shim using literal Windows paths', () => {
    const f = fixture();
    const result = f.run({ PHANTOM_PREFER_NATIVE: '1' });
    // Deliberately inert bytes cannot launch. Reaching the installed shim proves
    // the real hash and file writes handled brackets without executing a binary.
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(f.prefix, 'ashlr.exe'), 'utf8')).toBe('verified Windows package bytes');
    expect(readFileSync(join(f.prefix, 'phm.cmd'), 'utf8')).toContain('"%~dp0ashlr.exe" %*');
    expect(f.events()).toEqual([]);
  });
});
