/** Inert fixture help only; never launches a user CLI, protocol, app or session. */
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNativeLauncherCapabilities, inspectNativeLauncherCapabilities } from '../src/core/resources/launcher-capabilities.js';
import { createResourceLauncherHelpProbe, type ResourceLauncherCompatibilityOptions } from '../src/core/resources/launcher-compatibility.js';
import * as verify from '../src/core/run/verify-commands.js';

let root: string;
const codexGlobal = 'Usage: codex [OPTIONS]\n\nCommands:\n  exec  Run\n  app-server  Structured transport\n\nOptions:\n  --help  Help\n';
const codexExec = 'Usage: codex exec [OPTIONS]\n\nCommands:\n  resume  Continue\n\nOptions:\n  --json  JSON\n  --model  Model\n  --sandbox  Sandbox\n';
const codexServer = 'Usage: codex app-server [OPTIONS]\n\nOptions:\n  --listen  Transport\n';
const claudeGlobal = 'Usage: claude [options] [command] [prompt]\n\nOptions:\n  --print  Print\n  --output-format  Format\n  --resume  Continue\n  --desktop  Desktop\n\nCommands:\n  agents  Agent view\n';
const claudeAgents = 'Usage: claude agents [OPTIONS]\n\nOptions:\n  --json  JSON\n  --cwd  Directory\n';
function options(provider: 'codex' | 'claude' = 'codex', patch: Partial<ResourceLauncherCompatibilityOptions> = {}) {
  return { provider, command: ['/fixture/owner-launcher'], cwd: root, timeoutMs: 5000, ...patch };
}
function result(stdout: string, patch: Partial<verify.VerifySubprocessResult> = {}): verify.VerifySubprocessResult {
  return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, ...patch };
}
function mock(outputs = ['codex-cli 0.136.0', codexGlobal, codexExec, codexServer]) {
  let index = 0;
  return vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => result(outputs[index++] ?? ''));
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-capabilities-'))); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('bounded native launcher capability discovery', () => {
  it.skipIf(process.platform === 'win32')('requests four exact Codex help/version suffixes and cannot promote transport help to thread observation', async () => {
    const runner = mock();
    const report = await inspectNativeLauncherCapabilities(options());
    expect(runner.mock.calls.map(([argv]) => argv)).toEqual([
      ['/fixture/owner-launcher', '--version'], ['/fixture/owner-launcher', '--help'],
      ['/fixture/owner-launcher', 'exec', '--help'], ['/fixture/owner-launcher', 'app-server', '--help'],
    ]);
    expect(report).toMatchObject({ schemaVersion: 1, scope: 'native-launcher-capability-discovery', status: 'observed',
      version: '0.136.0', runtimeReadiness: 'not-inspected', sessionsInspected: false, controlEnabled: false, providerContactRequested: false });
    expect(report.capabilities.map((row) => [row.id, row.upstream, row.phantomTransport])).toEqual([
      ['cli-turn', 'advertised', 'native-cli'], ['cli-resume', 'advertised', 'native-cli'],
      ['app-server', 'advertised', 'not-implemented'], ['session-observation', 'unverified', 'not-implemented'],
      ['desktop-handoff', 'unverified', 'not-implemented'],
    ]);
    for (const [, config] of runner.mock.calls) {
      expect(config.timeoutMs).toBeGreaterThan(0); expect(config.timeoutMs).toBeLessThanOrEqual(5000);
      expect(config.maxOutputChars).toBe(64 * 1024); expect(config).not.toHaveProperty('input');
    }
    expect(JSON.stringify(report)).not.toMatch(/fixture|owner-launcher|Structured transport/);
  });
  it.skipIf(process.platform === 'win32')('requests only Claude agents help and version-gates advertised desktop handoff', async () => {
    const runner = mock(['2.1.280 (Claude Code)', claudeGlobal, claudeAgents]);
    const report = await inspectNativeLauncherCapabilities(options('claude'));
    expect(runner.mock.calls.map(([argv]) => argv.slice(1))).toEqual([['--version'], ['--help'], ['agents', '--help']]);
    expect(report.capabilities.find((row) => row.id === 'session-observation')).toMatchObject({ upstream: 'advertised', phantomTransport: 'not-implemented' });
    expect(report.capabilities.find((row) => row.id === 'desktop-handoff')!.upstream).toBe('unverified');

  });
  it('requires an exact numeric minimum version for declared Claude desktop handoff', () => {
    for (const version of [null, '2.1.284', '2.1.285', '2.2.0', '3.0.0', '3.0', '3.0.extra', '3.0.0 PRIVATE']) {
      const handoff = buildNativeLauncherCapabilities('claude', version, claudeGlobal, { agents: claudeAgents }).find((row) => row.id === 'desktop-handoff')!;
      expect(handoff.upstream).toBe(version === null || version === '2.1.284' || !/^\d+\.\d+\.\d+$/.test(version) ? 'unverified' : 'advertised');
      expect(handoff.phantomTransport).toBe('not-implemented');
    }
  });
  it.skipIf(process.platform === 'win32')('never probes commands mentioned only in prose or prefix-colliding declarations', async () => {
    const runner = mock(['codex-cli 0.136.0', 'Usage: codex [OPTIONS]\nExample: exec app-server\nCommands:\n  exec-extra  Not exec\n  app-server-extra  Not server\n']);
    const report = await inspectNativeLauncherCapabilities(options());
    expect(runner).toHaveBeenCalledTimes(2);
    expect(report.capabilities.filter((row) => row.upstream === 'advertised')).toEqual([]);
  });
  it('does not accept nested-topic help as evidence for its parent command', () => {
    for (const exec of [codexExec.replace('codex exec [', 'codex exec resume ['), codexExec.replace('codex exec [', 'codex exec unrelated [')]) {
      expect(buildNativeLauncherCapabilities('codex', '0.136.0', codexGlobal, { exec }).find((row) => row.id === 'cli-turn')!.upstream).toBe('not-advertised');
    }
    expect(buildNativeLauncherCapabilities('codex', '0.136.0', codexGlobal, { appServer: codexServer.replace('app-server [', 'app-server generate-ts [') }).find((row) => row.id === 'app-server')!.upstream).toBe('not-advertised');
    expect(buildNativeLauncherCapabilities('claude', '2.1.285', claudeGlobal, { agents: claudeAgents.replace('agents [', 'agents stop [') }).find((row) => row.id === 'session-observation')!.upstream).toBe('not-advertised');
  });
  it('rejects appended nested tokens and ambiguous parent Usage declarations', () => {
    for (const global of [codexGlobal.replace('[OPTIONS]', '[OPTIONS] stop'), `${codexGlobal}Usage: codex exec [OPTIONS]\n`]) {
      expect(buildNativeLauncherCapabilities('codex', '0.136.0', global, { exec: codexExec, appServer: codexServer }).every((row) => row.upstream === 'unverified')).toBe(true);
    }
    for (const exec of [codexExec.replace('[OPTIONS]', '[OPTIONS] resume'), `${codexExec}Usage: codex exec resume [OPTIONS]\n`]) {
      expect(buildNativeLauncherCapabilities('codex', '0.136.0', codexGlobal, { exec }).find((row) => row.id === 'cli-turn')!.upstream).toBe('not-advertised');
    }
  });
  it('reports unavailable on Windows without invoking native commands', async () => {
    const runner = mock();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(await inspectNativeLauncherCapabilities(options())).toMatchObject({ status: 'unavailable', reason: 'launcher-platform-unsupported' });
      expect(runner).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
  it('does not accept prose, other providers or wrong subcommand usage as a declaration', () => {
    const badFlags = 'Usage: codex exec [OPTIONS]\nExamples:\n  --json  --model --sandbox\nOptions:\n  --json-extra  prefix\n  --model-extra  prefix\n  --sandbox-extra  prefix\n';
    expect(buildNativeLauncherCapabilities('codex', '0.136.0', codexGlobal, { exec: badFlags, appServer: claudeAgents })
      .filter((row) => row.upstream === 'advertised')).toEqual([]);
    const badAgentHelp = claudeAgents.replace('claude agents', 'claude stop');
    expect(buildNativeLauncherCapabilities('claude', '2.1.285', claudeGlobal, { agents: badAgentHelp }).find((row) => row.id === 'session-observation')!.upstream).toBe('not-advertised');
  });
  it.skipIf(process.platform === 'win32')('does not retain unrecognized version text, descriptions, stderr or private paths', async () => {
    const runner = mock(['PRIVATE_VERSION fixture@example.invalid', codexGlobal, codexExec, codexServer]);
    const report = await inspectNativeLauncherCapabilities(options());
    expect(report.version).toBeNull(); expect(report.versionEvidence).toBe('unverified');
    expect(report.probeEffects).toContain('startup/cache effects are not attested');
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE_VERSION|fixture@example|owner-launcher/);
    expect(runner).toHaveBeenCalledTimes(4);
  });
  it.skipIf(process.platform === 'win32').each([
    [{ timedOut: true }, 'launcher-timed-out'], [{ cancelled: true }, 'launcher-cancelled'],
    [{ exitCode: 1 }, 'launcher-process-failed'], [{ outputTruncated: true }, 'launcher-output-limit'],
    [{ stdout: 'é'.repeat(40_000) }, 'launcher-output-limit'], [{ stderr: 'é'.repeat(40_000) }, 'launcher-output-limit'],
    [{ error: 'termination authority lost: PRIVATE' }, 'launcher-termination-uncertain'],
    [{ error: 'termination deadline elapsed with process-group exit unconfirmed' }, 'launcher-termination-uncertain'],
  ] as const)('withholds all advertised capabilities after a failed bounded invocation %j', async (patch, reason) => {
    const runner = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(result('SECRET output', patch));
    const report = await inspectNativeLauncherCapabilities(options());
    expect(report).toMatchObject({ status: 'unavailable', reason, controlEnabled: false });
    expect(report.capabilities.every((row) => row.upstream === 'unverified')).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1); expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it.skipIf(process.platform === 'win32').each([claudeGlobal, codexExec])('refuses a wrong product or subcommand-only global usage without probing subcommands', async (badGlobal) => {
    const runner = mock(['codex-cli 0.136.0', badGlobal]);
    expect(await inspectNativeLauncherCapabilities(options())).toMatchObject({ status: 'unavailable', reason: 'launcher-upstream-capability-unverified' });
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it.skipIf(process.platform === 'win32')('uses one shared deadline instead of resetting a timeout for each help invocation', async () => {
    const runner = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return result('codex-cli 0.136.0');
    });
    expect(await inspectNativeLauncherCapabilities(options('codex', { timeoutMs: 15 }))).toMatchObject({ status: 'unavailable', reason: 'launcher-timed-out' });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform === 'win32')('rejects non-help topic/provider requests and never retries after uncertain termination', async () => {
    const runner = vi.spyOn(verify, 'runVerifySubprocessAsync').mockResolvedValue(result('', { error: 'termination authority lost: PRIVATE' }));
    const probe = createResourceLauncherHelpProbe(options());
    await expect(probe.invoke('claude-agents')).rejects.toThrow('Unsupported launcher help topic');
    await expect(probe.invoke('turn/start' as never)).rejects.toThrow('Unsupported launcher help topic');
    expect(runner).not.toHaveBeenCalled();
    expect(await probe.invoke('version')).toBeNull();
    expect(await probe.invoke('global')).toBeNull();
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it.skipIf(process.platform === 'win32')('enforces four fixed help calls and refuses a fifth subprocess', async () => {
    const runner = mock(); const probe = createResourceLauncherHelpProbe(options());
    for (const topic of ['version', 'global', 'codex-exec', 'codex-app-server'] as const) await probe.invoke(topic);
    await expect(probe.invoke('global')).rejects.toThrow('Help probe invocation limit');
    expect(runner).toHaveBeenCalledTimes(4);
  });
  it.skipIf(process.platform === 'win32')('withholds partial advertisement after a later help invocation fails', async () => {
    let call = 0;
    const outputs = ['codex-cli 0.136.0', codexGlobal, codexExec];
    const runner = vi.spyOn(verify, 'runVerifySubprocessAsync').mockImplementation(async () => ++call === 4
      ? result('SECRET partial help', { error: 'termination authority lost: PRIVATE' }) : result(outputs[call - 1]!));
    const report = await inspectNativeLauncherCapabilities(options());
    expect(report).toMatchObject({ status: 'unavailable', reason: 'launcher-termination-uncertain', sessionsInspected: false, controlEnabled: false });
    expect(report.capabilities.every((row) => row.upstream === 'unverified')).toBe(true);
    expect(runner).toHaveBeenCalledTimes(4); expect(JSON.stringify(report)).not.toMatch(/SECRET|PRIVATE/);
  });
  it('rejects invalid and accessor-shaped inputs before any probe', async () => {
    const runner = mock();
    for (const patch of [{ command: ['relative'] }, { cwd: '/' }, { timeoutMs: 30001 }, { provider: 'grok' as const }]) {
      await expect(inspectNativeLauncherCapabilities(options('codex', patch))).rejects.toThrow();
    }
    const accessor = { ...options(), get provider() { throw new Error('PRIVATE getter'); } };
    await expect(inspectNativeLauncherCapabilities(accessor)).rejects.toThrow('Invalid resource launcher compatibility configuration');
    expect(runner).not.toHaveBeenCalled();
  });
  it('handles pre-cancellation without spawning', async () => {
    const runner = mock(); const controller = new AbortController(); controller.abort();
    expect(await inspectNativeLauncherCapabilities(options('codex', { signal: controller.signal }))).toMatchObject({ status: 'unavailable', reason: 'launcher-cancelled' });
    expect(runner).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')('real inert Node fixture receives only help/version and no credential variables', async () => {
    const binary = join(root, 'fixture.cjs'); const calls = join(root, 'calls.jsonl');
    writeFileSync(binary, `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,key:process.env.OPENAI_API_KEY})+'\\n');const outputs=${JSON.stringify({ '--version': 'codex-cli 0.136.0', '--help': codexGlobal, 'exec --help': codexExec, 'app-server --help': codexServer })};if(!Object.hasOwn(outputs,args.join(' ')))process.exit(9);console.log(outputs[args.join(' ')]);`);
    chmodSync(binary, 0o600); vi.stubEnv('OPENAI_API_KEY', 'SECRET fixture');
    const report = await inspectNativeLauncherCapabilities(options('codex', { command: [process.execPath, binary] }));
    expect(report.status).toBe('observed');
    const actual = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(actual.map((row) => row.args)).toEqual([['--version'], ['--help'], ['exec', '--help'], ['app-server', '--help']]);
    expect(actual.every((row) => !Object.hasOwn(row, 'key'))).toBe(true);
    expect(existsSync(join(root, 'sessions'))).toBe(false);
  });
});
