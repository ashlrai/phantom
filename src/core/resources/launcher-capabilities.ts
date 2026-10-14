/** Help declarations describe upstream surfaces, never permission or qualified execution. */
import { createResourceLauncherHelpProbe, resourceLauncherDeclaredCommands, resourceLauncherDeclaredFlags,
  resourceLauncherVersion, type ResourceLauncherCompatibilityOptions, type ResourceLauncherCompatibilityReason } from './launcher-compatibility.js';

export type NativeLauncherCapabilityId = 'cli-turn' | 'cli-resume' | 'app-server' | 'session-observation' | 'desktop-handoff';
export interface NativeLauncherCapability {
  id: NativeLauncherCapabilityId;
  upstream: 'advertised' | 'not-advertised' | 'unverified';
  phantomTransport: 'native-cli' | 'not-implemented';
  evidence: string[];
  reason: string;
}
export interface NativeLauncherCapabilities {
  schemaVersion: 1;
  scope: 'native-launcher-capability-discovery';
  provider: 'codex' | 'claude';
  status: 'observed' | 'unavailable';
  reason: ResourceLauncherCompatibilityReason | 'launcher-capabilities-observed';
  version: string | null;
  versionEvidence: 'recognized-cli-version' | 'unverified';
  runtimeReadiness: 'not-inspected';
  sessionsInspected: false;
  controlEnabled: false;
  providerContactRequested: false;
  probeEffects: 'Help/version requested; trusted launcher and vendor startup/cache effects are not attested.';
  startedAt: string;
  finishedAt: string;
  capabilities: NativeLauncherCapability[];
}
const IDS: readonly NativeLauncherCapabilityId[] = ['cli-turn', 'cli-resume', 'app-server', 'session-observation', 'desktop-handoff'];

function declaredUsage(output: string, provider: string, command = ''): boolean {
  const usages = output.split(/\r?\n/).filter((line) => /^Usage:/i.test(line));
  if (usages.length !== 1) return false;
  const match = /^Usage:\s+(\S+)(?:\s+(.*?))?\s*$/i.exec(usages[0]!);
  if (match?.[1] !== provider) return false;
  let tail = match[2] ?? '';
  if (command) {
    if (!tail.startsWith(`${command} `) && tail !== command) return false;
    tail = tail.slice(command.length).trim();
  }
  // Exact parent and conventional placeholders only. Nested command help cannot
  // authorize its parent, including a nested token after a valid placeholder.
  return /^(?:(?:\[[A-Za-z][A-Za-z0-9_|. -]*\]|<[A-Za-z][A-Za-z0-9_|. -]*>)(?:\.{3})?\s*)*$/.test(tail);
}

function row(id: NativeLauncherCapabilityId, upstream: NativeLauncherCapability['upstream'],
  evidence: string[], reason: string): NativeLauncherCapability {
  return { id, upstream, phantomTransport: id === 'cli-turn' || id === 'cli-resume' ? 'native-cli' : 'not-implemented', evidence, reason };
}
function claudeDesktopVersion(version: string | null): boolean {
  if (!version || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(version)) return false;
  const parts = version.split('.').map(Number);
  const floor = [2, 1, 285];
  for (let i = 0; i < floor.length; i++) if (parts[i] !== floor[i]) return parts[i]! > floor[i]!;
  return true;
}

/** Pure projection: raw output, private paths and descriptions are never retained. */
export function buildNativeLauncherCapabilities(provider: 'codex' | 'claude', version: string | null,
  globalHelp: string, secondary: { exec?: string; appServer?: string; agents?: string } = {}): NativeLauncherCapability[] {
  if (!declaredUsage(globalHelp, provider)) return IDS.map((id) => row(id, 'unverified', [], 'Global provider help identity is unverified.'));
  const commands = resourceLauncherDeclaredCommands(globalHelp);
  const globalFlags = resourceLauncherDeclaredFlags(globalHelp, ['--print', '--output-format', '--resume', '--desktop']);
  const has = (flags: string[], required: string[]) => required.every((flag) => flags.includes(flag));
  if (provider === 'codex') {
    const exec = commands.includes('exec') && secondary.exec !== undefined && declaredUsage(secondary.exec, provider, 'exec');
    const execFlags = exec ? resourceLauncherDeclaredFlags(secondary.exec!, ['--json', '--model', '--sandbox']) : [];
    const turn = exec && has(execFlags, ['--json', '--model', '--sandbox']);
    const resume = exec && resourceLauncherDeclaredCommands(secondary.exec!).includes('resume');
    const appServer = commands.includes('app-server') && secondary.appServer !== undefined &&
      declaredUsage(secondary.appServer, provider, 'app-server') &&
      resourceLauncherDeclaredFlags(secondary.appServer, ['--listen', '--stdio']).length > 0;
    return [
      row('cli-turn', turn ? 'advertised' : 'not-advertised', turn ? ['exec', '--json', '--model', '--sandbox'] : [], 'Native CLI adapter exists; argument combinations, authentication and execution are not qualified here.'),
      row('cli-resume', resume ? 'advertised' : 'not-advertised', resume ? ['exec resume'] : [], 'Native IDs are retained by the CLI adapter; no session was loaded or resumed.'),
      row('app-server', appServer ? 'advertised' : 'not-advertised', appServer ? ['app-server', 'help-declared transport flag'] : [], 'General session transport is not implemented; existing account metadata probes are separate.'),
      row('session-observation', 'unverified', [], 'Help does not qualify thread/list or thread/read; exact-binary protocol schema and scoped transport need separate review.'),
      row('desktop-handoff', 'unverified', [], 'CLI help does not establish attachment to a running desktop app or ownership of its conversations.'),
    ];
  }
  const turn = has(globalFlags, ['--print', '--output-format']);
  const resume = globalFlags.includes('--resume');
  const observe = commands.includes('agents') && secondary.agents !== undefined && declaredUsage(secondary.agents, provider, 'agents') &&
    resourceLauncherDeclaredFlags(secondary.agents, ['--json', '--cwd']).length === 2;
  const handoffFlags = has(globalFlags, ['--desktop', '--resume']);
  const handoff = handoffFlags && claudeDesktopVersion(version);
  return [
    row('cli-turn', turn ? 'advertised' : 'not-advertised', turn ? ['--print', '--output-format'] : [], 'Streamed CLI adapter exists; account, permission and execution readiness remain uninspected.'),
    row('cli-resume', resume ? 'advertised' : 'not-advertised', resume ? ['--resume'] : [], 'Native IDs are retained by the CLI adapter; no session was loaded or resumed.'),
    row('app-server', 'unverified', [], 'No Codex-compatible structured transport is inferred for Claude from CLI help.'),
    row('session-observation', observe ? 'advertised' : 'not-advertised', observe ? ['agents', '--json', '--cwd'] : [], 'No session list was requested. Supervisor startup effects and installed-version listing need separate qualification.'),
    row('desktop-handoff', handoff ? 'advertised' : handoffFlags ? 'unverified' : 'not-advertised', handoff ? ['--desktop', '--resume', 'CLI >=2.1.285'] : [], 'Help and minimum version only; idle-session transfer and desktop acceptance are unqualified.'),
  ];
}

/** Four fixed help/version invocations at most. No sessions, protocols or provider state are read. */
export async function inspectNativeLauncherCapabilities(options: ResourceLauncherCompatibilityOptions): Promise<NativeLauncherCapabilities> {
  const probe = createResourceLauncherHelpProbe(options);
  if (probe.provider !== 'codex' && probe.provider !== 'claude') throw new Error('Unsupported native capability provider');
  const provider = probe.provider;
  let version: string | null = null;
  const result = (status: NativeLauncherCapabilities['status'], reason: NativeLauncherCapabilities['reason'],
    capabilities = IDS.map((id) => row(id, 'unverified', [], 'Help evidence is unavailable; no readiness is inferred.'))): NativeLauncherCapabilities => ({
    schemaVersion: 1, scope: 'native-launcher-capability-discovery', provider, status, reason, version,
    versionEvidence: version === null ? 'unverified' : 'recognized-cli-version', runtimeReadiness: 'not-inspected',
    sessionsInspected: false, controlEnabled: false, providerContactRequested: false,
    probeEffects: 'Help/version requested; trusted launcher and vendor startup/cache effects are not attested.',
    startedAt: probe.startedAt, finishedAt: new Date().toISOString(), capabilities,
  });
  if (options.signal?.aborted) return result('unavailable', 'launcher-cancelled');
  if (process.platform === 'win32') return result('unavailable', 'launcher-platform-unsupported');
  const versionOutput = await probe.invoke('version');
  if (versionOutput === null) return result('unavailable', probe.failure()!);
  version = resourceLauncherVersion(provider, versionOutput);
  const globalHelp = await probe.invoke('global');
  if (globalHelp === null) return result('unavailable', probe.failure()!);
  if (!declaredUsage(globalHelp, provider)) return result('unavailable', 'launcher-upstream-capability-unverified');
  const commands = resourceLauncherDeclaredCommands(globalHelp);
  const secondary: { exec?: string; appServer?: string; agents?: string } = {};
  for (const [command, topic, target] of provider === 'codex'
    ? [['exec', 'codex-exec', 'exec'], ['app-server', 'codex-app-server', 'appServer']] as const
    : [['agents', 'claude-agents', 'agents']] as const) {
    if (!commands.includes(command)) continue;
    const help = await probe.invoke(topic);
    if (help === null) return result('unavailable', probe.failure()!);
    secondary[target] = help;
  }
  return result('observed', 'launcher-capabilities-observed', buildNativeLauncherCapabilities(provider, version, globalHelp, secondary));
}
