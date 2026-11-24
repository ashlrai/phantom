import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Execute the shipped POSIX entrypoint with inert tools. No network, real npm
// install, user configuration or native service manager is touched.
describe('release installer execution', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'phantom install '));
    fixtures.push(dir);
    const home = join(dir, 'home');
    const bins = join(dir, 'tools');
    mkdirSync(home); mkdirSync(bins);
    const tarball = join(dir, 'package.tgz');
    writeFileSync(tarball, 'verified package bytes');
    const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
    const phm = '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_DIR/phm.log"\nif [ "$1" = doctor ]; then exit "${TEST_DOCTOR_EXIT:-0}"; fi\n';
    writeFileSync(join(dir, 'native'), phm);
    const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [{
      name: 'ashlr-linux-x64', digest: 'sha256:' + createHash('sha256').update(phm).digest('hex'),
      browser_download_url: 'https://github.com/ashlrai/phantom/releases/download/v1.2.3/ashlr-linux-x64',
    }] };
    const metadata = { name: '@ashlr/phantom', version: '1.2.3', dist: {
      integrity, tarball: 'https://registry.npmjs.org/@ashlr/phantom/-/phantom-1.2.3.tgz',
    } };
    const helper = join(dir, 'tools.cjs');
    writeFileSync(helper, `
const fs = require('node:fs'), path = require('node:path');
const [tool, ...args] = process.argv.slice(2), dir = process.env.TEST_DIR;
const log = text => fs.appendFileSync(path.join(dir, 'events'), text + '\\n');
if (tool === 'uname') process.stdout.write(args[0] === '-s' ? process.env.TEST_OS || 'Linux' : 'x86_64');
if (tool === 'gh') { log('attestation ' + args.slice(-4).join(' ')); process.exit(Number(process.env.TEST_ATTEST_EXIT || 0)); }
if (tool === 'verifier') { log('verify ' + args.slice(1).join(' ')); process.exit(Number(process.env.TEST_VERIFY_EXIT || 0)); }
if (tool === 'curl') {
  const url = args.at(-1); log(url);
  if (url.startsWith('https://api.github.com/')) process.stdout.write(fs.readFileSync(path.join(dir, 'release.json')));
  else if (args.includes('-o')) fs.copyFileSync(path.join(dir, url.endsWith('.tgz') ? 'package.tgz' : 'native'), args[args.indexOf('-o') + 1]);
  else process.stdout.write(fs.readFileSync(path.join(dir, 'metadata.json')));
}
if (tool === 'npm') {
  log('npm'); fs.copyFileSync(args.at(-1), path.join(dir, 'installed.tgz'));
  const bin = path.join(args[args.indexOf('--prefix') + 1], 'bin'); fs.mkdirSync(bin, {recursive:true});
  fs.copyFileSync(path.join(dir, 'native'), path.join(bin, 'phm')); fs.chmodSync(path.join(bin, 'phm'), 0o755);
}
`);
    for (const name of ['uname', 'curl', 'npm', 'gh', 'verifier']) {
      const file = join(bins, name);
      writeFileSync(file, `#!/bin/sh\nexec "$TEST_NODE" "$TEST_HELPER" ${name} "$@"\n`);
      chmodSync(file, 0o755);
    }
    writeFileSync(join(bins, 'node'), '#!/bin/sh\nexec "$TEST_NODE" "$@"\n');
    chmodSync(join(bins, 'node'), 0o755);
    const run = (extra: Record<string, string> = {}) => {
      writeFileSync(join(dir, 'release.json'), JSON.stringify(release));
      writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata));
      return spawnSync('/bin/sh', [join(root, 'scripts/install-release.sh')], {
        env: { PATH: `${bins}:/usr/bin:/bin`, HOME: home, TMPDIR: dir, TEST_DIR: dir,
          TEST_NODE: process.execPath, TEST_HELPER: helper, PHANTOM_PREFIX: join(home, 'prefix'), ...extra },
        encoding: 'utf8', timeout: 10_000,
      });
    };
    const events = () => existsSync(join(dir, 'events')) ? readFileSync(join(dir, 'events'), 'utf8') : '';
    return { dir, bins, tarball, integrity, release, metadata, run, events };
  }

  it('verifies a copied package, invokes the verifier, and completes onboarding despite doctor setup items', () => {
    const f = fixture();
    const result = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity,
      PHANTOM_VERIFY_RELEASE: join(f.bins, 'verifier'), TEST_DOCTOR_EXIT: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.dir, 'installed.tgz'), 'utf8')).toBe('verified package bytes');
    expect(f.events()).toMatch(/^verify npm.*\nnpm\n$/);
    expect(readFileSync(join(f.dir, 'phm.log'), 'utf8')).toBe('--version\ndoctor\ndaemon install\n');
    expect(result.stdout).toContain('doctor found setup items');
  });

  it('rejects altered copied bytes before installation', () => {
    const f = fixture();
    writeFileSync(join(f.bins, 'cp'), '#!/bin/sh\n/bin/cp "$@"\nprintf corrupt > "$2"\n');
    chmodSync(join(f.bins, 'cp'), 0o755);
    const result = f.run({ PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release integrity verification failed');
    expect(f.events()).not.toContain('npm');
  });

  it('honors the pinned native version and passes its identity to the verifier', () => {
    const f = fixture();
    const result = f.run({ PHANTOM_PREFER_NATIVE: '1', PHANTOM_VERSION: '1.2.3', PHANTOM_VERIFY_RELEASE: join(f.bins, 'verifier') });
    expect(result.status, result.stderr).toBe(0);
    expect(f.events()).toContain('/releases/tags/v1.2.3\n');
    expect(f.events()).toContain('verify native 1.2.3');
    expect(f.events()).not.toContain('/releases/latest');
    expect(f.events()).not.toContain('npm');
  });

  it('defaults to the complete npm package without probing CLI-only assets', () => {
    const f = fixture();
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(f.events()).toContain('https://registry.npmjs.org/@ashlr/phantom/latest');
    expect(f.events()).toContain('\nnpm\n');
    expect(f.events()).not.toContain('api.github.com');
  });

  it('refuses a native checksum mismatch before installation or fallback', () => {
    const f = fixture(); f.release.assets[0]!.digest = 'sha256:' + '0'.repeat(64);
    const result = f.run({ PHANTOM_PREFER_NATIVE: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Release asset checksum verification failed');
    expect(existsSync(join(f.dir, 'home', 'prefix', 'bin', 'ashlr'))).toBe(false);
    expect(f.events()).not.toContain('npm');
  });

  it.each(['https://example.com/payload', 'https://github.com/other/project/releases/download/v1.2.3/ashlr-linux-x64'])(
    'refuses an unbound native URL %s and uses the verified npm package', url => {
      const f = fixture(); f.release.assets[0]!.browser_download_url = url;
      const result = f.run({ PHANTOM_PREFER_NATIVE: '1', PHANTOM_VERSION: '1.2.3' });
      expect(result.status, result.stderr).toBe(0);
      expect(f.events()).not.toContain(url);
      expect(f.events()).toContain('attestation --repo ashlrai/phantom --hostname github.com');
      expect(f.events()).toContain('npm');
    });

  it('rejects a registry response for a different pinned version', () => {
    const f = fixture(); f.release.assets = [];
    const result = f.run({ PHANTOM_VERSION: '2.0.0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Registry version mismatch');
    expect(f.events()).not.toContain('\nnpm\n');
  });

  it('fails closed when the verifier or attestation rejects the artifact', () => {
    for (const failure of ['verifier', 'attestation']) {
      const f = fixture(); f.release.assets = [];
      const result = f.run(failure === 'verifier'
        ? { PHANTOM_VERIFY_RELEASE: join(f.bins, 'verifier'), TEST_VERIFY_EXIT: '9' }
        : { TEST_ATTEST_EXIT: '9' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(failure === 'verifier' ? 'Release verifier refused' : 'attestation verification failed');
      expect(f.events()).not.toContain('\nnpm\n');
    }
  });

  it('leaves macOS resident authorization to its existing command', () => {
    const f = fixture();
    const result = f.run({ TEST_OS: 'Darwin', PHANTOM_TARBALL: f.tarball, PHANTOM_INTEGRITY: f.integrity });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.dir, 'phm.log'), 'utf8')).toBe('--version\ndoctor\n');
    expect(result.stdout).toContain('phm authority resident start');
  });
});

