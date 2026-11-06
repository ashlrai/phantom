import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { DoctorReport } from '../../src/core/types.js';

const cli = fileURLToPath(new URL('../../src/cli/index.ts', import.meta.url));
const tsx = import.meta.resolve('tsx');
const fixture = new URL('./fixtures/fake-locus.mjs', import.meta.url).href;
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    // Never follow a generated link outside this disposable home.
    if (stat.isSymbolicLink()) throw new Error('Unexpected link in CLI state');
    return stat.isDirectory() ? filesUnder(path) : [path];
  });
}

function runDoctor(status: 'ready' | 'protected' | 'unsafe', json: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-locus-integration-'));
  homes.push(home);
  const bin = join(home, 'bin');
  const state = join(home, '.ashlr');
  const locusHome = join(home, '.locus');
  for (const directory of [bin, state, locusHome]) mkdirSync(directory, { mode: 0o700 });
  // Only the availability lookup is on PATH; no installed companion or
  // provider CLI can accidentally run against a developer account.
  if (process.platform !== 'win32') symlinkSync('/usr/bin/which', join(bin, 'which'));
  const argvFile = join(home, 'argv.jsonl');
  const pinFile = join(locusHome, 'fixture-pin.json');
  const credential = 'synthetic-locus-' + randomBytes(24).toString('hex');
  const ready = status === 'ready';
  writeFileSync(pinFile, JSON.stringify({
    exitCode: ready ? 0 : status === 'unsafe' ? 2 : 1,
    report: {
      version: '1', ready, status, status_oneline: 'integration:fixture-tenant', home: locusHome,
      pin: { pinned: true, alias: 'integration', tenant: 'fixture-tenant', seal_ok: true,
        credential },
      mcp_registered: { claude: true, cursor: true, codex: true },
      doctor: { credential }, commands: {}, required_servers: ['locus', 'phantom'],
      mcp_command: 'locus-mcp', next_steps: [],
    },
  }), { mode: 0o600 });
  writeFileSync(join(state, 'config.json'), JSON.stringify({
    version: 1, roots: [], models: { lmstudio: '', ollama: '', providerChain: [] },
    localInference: { enabled: false },
  }), { mode: 0o600 });
  const args = ['--import', tsx, cli, 'doctor', ...(json ? ['--json'] : [])];
  // Deliberately do not spread process.env: no host credentials, Locus pin,
  // NODE_OPTIONS, ASHLR_HOME, MCP registrations or provider config are inherited.
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home, ASHLR_HOME: state, LOCUS_HOME: locusHome,
    PATH: process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : bin,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    TMPDIR: home, TMP: home, TEMP: home, NO_COLOR: '1', LOCUS_NOTIFY: '0',
    LOCUS_BIN: process.execPath, NODE_OPTIONS: `--import=${fixture}`,
    PHM_LOCUS_FIXTURE_ARGV: argvFile, PHM_LOCUS_FIXTURE_PIN: pinFile,
    // Synthetic only: an ambient credential and a private report credential
    // must both stay out of observable output and subprocess arguments.
    AWS_SECRET_ACCESS_KEY: credential,
  };
  const result = spawnSync(process.execPath, args, {
    cwd: home, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  // Boolean assertions keep even a failed security regression from printing
  // a canary through Vitest's expected/received diff.
  const observables = [result.stdout ?? '', result.stderr ?? '', JSON.stringify(args),
    ...[...filesUnder(state), ...filesUnder(locusHome).filter(path => path !== pinFile)]
      .map(path => readFileSync(path, 'utf8')),
    ...(existsSync(argvFile) ? [readFileSync(argvFile, 'utf8')] : [])];
  expect(observables.some(text => text.includes(credential)), 'credential reached output, logs or argv').toBe(false);
  expect(result.error?.code, 'CLI must complete within its subprocess deadline').toBeUndefined();
  expect(result.signal).toBeNull();
  const events = readFileSync(argvFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{
    kind: string; argv: string[]; credentialPresent?: boolean;
  }>;
  expect(events.filter(event => event.kind === 'pin').map(event => event.credentialPresent)).toEqual([true]);
  expect(events.filter(event => event.kind === 'locus').map(event => event.argv))
    .toEqual([['agent', 'report', '--json']]);
  expect(events.some(event => event.kind === 'spawnSync' && event.argv[0] === process.execPath &&
    event.argv.slice(1).join(' ') === 'agent report --json')).toBe(true);
  return result;
}

describe('Phantom CLI under a fake Locus pin', () => {
  it.each(['ready', 'protected', 'unsafe'] as const)('projects %s metadata without exposing credentials', status => {
    const result = runDoctor(status, true);
    let report: DoctorReport;
    try { report = JSON.parse(result.stdout) as DoctorReport; }
    catch { throw new Error('doctor did not emit a JSON report'); }
    expect(report.checks.find(check => check.id === 'locus')).toMatchObject({
      status: status === 'ready' ? 'pass' : status === 'unsafe' ? 'fail' : 'warn',
      detail: `status=${status} pin=integration:fixture-tenant ready=${status === 'ready'}`,
    });
    // Unrelated missing local tools can fail doctor in this intentionally bare
    // HOME. Its exit code must still agree with its complete JSON report.
    expect(result.status).toBe(report.summary.fail > 0 ? 1 : 0);
    if (status === 'unsafe') expect(result.status).toBe(1);
  });

  it('keeps the human report values-free as well', () => {
    const result = runDoctor('ready', false);
    expect(result.stdout).toContain('Locus identity plane');
    expect(result.stdout).toContain('status=ready pin=integration:fixture-tenant ready=true');
    expect([0, 1]).toContain(result.status);
  });
});
