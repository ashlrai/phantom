/**
 * Real cross-repository integration; requires an explicitly provisioned Secrets
 * binary, never PATH discovery or a developer vault. Missing provisioning fails.
 * HOME=$(mktemp -d) PHANTOM_CONTRACT_BIN=/absolute/path/phantom \
 *   node --import tsx --test test/contracts/phantom-secrets-exec.integration.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { phantomWrap } from '../../src/core/run/engines.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));

test('Phantom engine exec through real Secrets keeps a canary out of argv, logs and child env', { timeout: 90_000 }, () => {
  const selected = process.env.PHANTOM_CONTRACT_BIN;
  assert.ok(selected && isAbsolute(selected), 'Provision an absolute PHANTOM_CONTRACT_BIN; this integration must not silently skip');
  const binary = realpathSync(selected);
  const root = mkdtempSync(join(tmpdir(), 'phm-secrets-integration-'));
  // Not an account credential. Only its digest enters the child, never its value.
  const canary = `sk-proj-INTEGRATIONONLY${randomBytes(24).toString('hex')}`;
  const digest = createHash('sha256').update(canary).digest('hex');
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(project);
  const env = {
    HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'),
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    XDG_CACHE_HOME: home, APPDATA: home, LOCALAPPDATA: home,
    TMPDIR: root, TMP: root, TEMP: root,
    PATH: [dirname(binary), dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    NO_COLOR: '1', PHANTOM_NO_UPDATE_CHECK: '1',
    PHANTOM_VAULT_PASSPHRASE: 'disposable-integration-passphrase',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
  };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const transcript = [];
  function run(bin, args, input) {
    assert.equal(JSON.stringify([bin, args]).includes(canary), false, 'credential entered argv');
    const result = spawnSync(bin, args, {
      cwd: project, env, input, encoding: 'utf8', timeout: 25_000,
      maxBuffer: 1024 * 1024, windowsHide: true,
    });
    transcript.push(result.stdout ?? '', result.stderr ?? '');
    // Boolean assertions deliberately prevent test failure diffs exposing values.
    assert.equal(transcript.some(text => text.includes(canary)), false, 'credential entered stdout/stderr');
    assert.equal(Boolean(result.error), false, 'subprocess launch or deadline failure (output withheld)');
    assert.equal(result.signal, null, 'subprocess terminated by signal');
    assert.equal(result.status, 0, 'subprocess failed (output withheld)');
    return result.stdout;
  }
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) assert.equal(readFileSync(path).includes(Buffer.from(canary)), false, 'credential persisted in fixture files/logs');
    }
  }
  try {
    assert.match(run(binary, ['--version']), /^phantom \d+\.\d+\.\d+/);
    run(binary, ['init', '--empty']);
    run(binary, ['add', 'OPENAI_API_KEY', '--stdin'], `${canary}\n`);
    const probe = join(project, 'probe.cjs');
    writeFileSync(probe, `
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = value => createHash('sha256').update(value).digest('hex');
const e = process.env;
const leak = [...Object.values(e), ...process.argv].some(value => hash(value) === process.argv[2]);
const phm = spawnSync(process.execPath, ['--import', ${JSON.stringify(join(repo, 'node_modules/tsx/dist/loader.mjs'))}, ${JSON.stringify(join(repo, 'src/cli/index.ts'))}, '--version'], { env: e, encoding: 'utf8', timeout: 15000 });
console.log(JSON.stringify({ leak, placeholder: /^phm_[A-Za-z0-9_-]+$/.test(e.OPENAI_API_KEY || ''), proxy: /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(e.OPENAI_BASE_URL || ''), phmStatus: phm.status, phmVersion: /\\d+\\.\\d+\\.\\d+/.test(phm.stdout || '') }));
process.stdout.write(phm.stdout || '');
process.stderr.write(phm.stderr || '');
`);
    run(process.execPath, ['--check', probe]);
    const command = phantomWrap({ bin: process.execPath, args: [probe, digest], cwd: project }, {});
    assert.equal(command.bin, 'phantom');
    assert.deepEqual(command.args.slice(0, 2), ['exec', '--']);
    const output = run(binary, command.args);
    const line = output.split(/\r?\n/).find(value => value.startsWith('{'));
    assert.ok(line, 'wrapped child did not report');
    assert.deepEqual(JSON.parse(line), { leak: false, placeholder: true, proxy: true, phmStatus: 0, phmVersion: true });
    scan(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
