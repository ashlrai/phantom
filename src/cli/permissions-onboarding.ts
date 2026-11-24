/** Guided setup composes existing authority commands without changing their checks. */
import { execFile } from 'node:child_process';
import { buildPermissionRows, type PermissionId, type PermissionObservation, type PermissionObservations } from '../core/permissions-onboarding.js';
import type { AuthoritySetupReportV1, AutonomySwitch } from '../core/authority/types.js';
import type { AuthorityCliDeps } from './authority.js';

// Fixed scripts only. Status never requests consent or sends an AppleEvent.
export const CLI_PERMISSION_PREFLIGHT = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function check(fn) { try { return fn(); } catch (_) { return null; } }
function automation(target) { return check(function () {
  ObjC.import('AppKit'); ObjC.import('Carbon');
  var desc = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(target);
  return Number($.AEDeterminePermissionToAutomateTarget(desc.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false));
}); }
JSON.stringify({accessibility: check(function () { return Boolean($.AXIsProcessTrusted()); }),
screen: check(function () { return Boolean($.CGPreflightScreenCaptureAccess()); }),
automationMessages: automation('com.apple.MobileSMS'), automationSystemEvents: automation('com.apple.systemevents')})`;

/** This separate allowlist is reached only after an explicit choice and a fresh missing preflight. */
export function permissionRequestScript(id: PermissionId): string | null {
  if (id === 'accessibility') return "ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}));";
  if (id === 'screen') return "ObjC.import('CoreGraphics'); $.CGRequestScreenCaptureAccess();";
  const target = id === 'automation-messages' ? 'com.apple.MobileSMS' : id === 'automation-system-events' ? 'com.apple.systemevents' : null;
  return target ? `ObjC.import('AppKit'); ObjC.import('Carbon'); var desc = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier('${target}'); $.AEDeterminePermissionToAutomateTarget(desc.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, true);` : null;
}

export async function requestCliPermission(id: PermissionId): Promise<void> {
  const script = permissionRequestScript(id);
  if (!script || process.platform !== 'darwin') throw new Error('This permission must be reviewed manually.');
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 60_000, maxBuffer: 8_192 }, (error) => error ? reject(new Error('The permission request did not complete.')) : resolve());
  });
}

export function decodePermissionProbe(text: string): PermissionObservations {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid permission probe');
  const data = value as Record<string, unknown>;
  const automation = (code: unknown): PermissionObservation => ({
    status: code === 0 ? 'granted' : code === -1743 || code === -1744 ? 'missing' : 'unknown',
    reason: code === 0 ? 'The nonprompting AppleEvents permission probe succeeded.'
      : code === -1743 || code === -1744 ? 'Automation is denied or still requires your consent.'
      : code === -600 ? 'automation-target-not-running'
      : 'The nonprompting AppleEvents probe could not determine access. Check the target in System Settings.',
  });
  return {
    accessibility: typeof data.accessibility === 'boolean' ? data.accessibility : null,
    screen: typeof data.screen === 'boolean' ? data.screen : null,
    automationMessages: automation(data.automationMessages), automationSystemEvents: automation(data.automationSystemEvents),
  };
}

/** Bounded child process; neither diagnostics nor arbitrary native output reach the report. */
export async function probeCliPermissions(platform = process.platform): Promise<PermissionObservations> {
  if (platform !== 'darwin') return {};
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CLI_PERMISSION_PREFLIGHT], { encoding: 'utf8', timeout: 5_000, maxBuffer: 8_192 }, (error, stdout) => {
      if (error) { resolve({}); return; }
      try { resolve(decodePermissionProbe(stdout)); } catch { resolve({}); }
    });
  });
}

export interface PermissionsOnboardingDeps {
  platform: string;
  probe(): Promise<PermissionObservations>;
  plan(): Promise<AuthoritySetupReportV1>;
  authority(args: string[]): Promise<number>;
  request(id: PermissionId): Promise<void>;
  openSettings(url: string): Promise<void>;
  confirm(question: string): Promise<boolean>;
  out(line: string): void;
  err(line: string): void;
}

export async function runPermissionsOnboarding(args: string[], deps: PermissionsOnboardingDeps): Promise<number> {
  const allowed = new Set(['--full-permissions', '--json', '--dry-run']);
  if (args.some((arg) => !allowed.has(arg))) {
    deps.err('Usage: phm authority setup --full-permissions [--json|--dry-run]. Every action needs your explicit choice; --yes is not supported.');
    return 2;
  }
  const [observed, authority] = await Promise.all([deps.probe().catch(() => ({})), deps.plan().catch(() => null)]);
  const report = {
    schema: 'phantom.permissions-onboarding.v1', checkedAt: new Date().toISOString(), platform: deps.platform,
    scope: 'cli-probe', scopeDetail: 'Permissions belong to the probe process and its responsible terminal. They do not establish permission for the Phantom desktop app or other agents.',
    permissions: buildPermissionRows(observed, deps.platform), authority,
    agents: { status: 'unknown', command: 'phm verse', detail: 'Connect and verify your chosen agents in Apps & Accounts. This status command does not inspect credentials or connect accounts.' },
  };
  if (args.includes('--json')) { deps.out(JSON.stringify(report, null, 2)); return 0; }
  deps.out(`Full permissions setup\n${report.scopeDetail}`);
  for (const row of report.permissions) deps.out(`${row.label}: ${row.status}. ${row.reason}`);
  if (!authority) deps.out('Authority setup status is unavailable. Run phm authority setup --dry-run --json to retry.');
  for (const row of authority?.steps ?? []) deps.out(`${row.step}: ${row.status}${row.command ? `; ${row.command}` : ''}${row.link ? `; ${row.link}` : ''}`);
  deps.out(`${report.agents.detail} Run ${report.agents.command}.`);
  if (args.includes('--dry-run')) return 0;
  if (deps.platform === 'darwin') {
    for (const row of report.permissions) {
      if (row.status === 'granted') continue;
      if (row.status === 'missing' && await deps.confirm(`Request macOS consent for ${row.label}? You can decline the system prompt.`)) {
        const fresh = buildPermissionRows(await deps.probe().catch(() => ({})), deps.platform).find((item) => item.id === row.id)!;
        if (fresh.status === 'granted') { deps.out(`${row.label}: granted; no request needed.`); continue; }
        if (fresh.status === 'missing') {
          try { await deps.request(row.id); }
          catch { deps.err(`${row.label}: the permission request did not complete. Review it manually.`); }
          const updated = buildPermissionRows(await deps.probe().catch(() => ({})), deps.platform).find((item) => item.id === row.id)!;
          deps.out(`${row.label}: ${updated.status}. ${updated.reason}`);
          if (updated.status === 'granted') continue;
        }
      }
      if (await deps.confirm(`Open ${row.label} settings? Make any grant yourself, then return here.`)) {
        try { await deps.openSettings(row.settingsUrl); }
        catch { deps.err(`Could not open ${row.label}. Open Privacy & Security in System Settings manually.`); }
      }
    }
  }
  // Setup prerequisites remain explicit command handoffs. Never bulk-run legacy setup:
  // it can create repositories/rulesets and offers a different authority level.
  const grant = authority?.steps.find((row) => row.id === 'standing-grant');
  const active = grant?.status === 'already' || grant?.status === 'done';
  // A dry-run skips downstream observations after an unmet prerequisite. Only
  // the next grant step establishes readiness to review a new signature.
  const readyForGrant = authority?.next === 'standing-grant' && (grant?.status === 'waiting-on-you' || grant?.status === 'skipped');
  if (active || readyForGrant) {
    if (active && !await deps.confirm('A grant is already active. Change its current authority level?')) return 0;
    deps.out('Choose authority: Off disables autonomy; Propose prepares work; Autonomous acts within the signed grant. Stop and revoke remain available.');
    if (await deps.confirm('Choose Off without signing a new grant?')) return deps.authority(['switch', 'off']);
    let level: AutonomySwitch = 'off';
    if (await deps.confirm(`Choose Propose${active ? ' within the existing grant' : ' and review a Touch ID grant'}?`)) level = 'propose';
    else if (await deps.confirm(`Choose Autonomous${active ? ' within the existing grant' : ' and review a Touch ID grant'}?`)) level = 'autonomous';
    if (level !== 'off') return deps.authority(active ? ['switch', level] : ['grant', '--switch', level]);
  } else {
    deps.out('Resolve the reported authority prerequisite and rerun this guide before reviewing a new grant. You can always lower authority with phm authority switch off.');
  }
  deps.out('Run this guide again to refresh. Granted permissions are skipped; unknown permissions still need manual verification.');
  return 0;
}

export async function runFullPermissionsSetup(args: string[], authorityDeps: AuthorityCliDeps): Promise<number> {
  const { planAuthoritySetup, runAuthorityCli } = await import('./authority.js');
  return runPermissionsOnboarding(args, {
    platform: process.platform, probe: () => probeCliPermissions(), plan: () => planAuthoritySetup(),
    request: requestCliPermission,
    authority: (next) => runAuthorityCli(next, authorityDeps), confirm: authorityDeps.confirm, out: authorityDeps.out, err: authorityDeps.err,
    openSettings: (url) => new Promise((resolve, reject) => {
      execFile('/usr/bin/open', [url], { timeout: 5_000 }, (error) => error ? reject(error) : resolve());
    }),
  });
}
