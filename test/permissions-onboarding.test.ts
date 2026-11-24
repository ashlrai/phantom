import { describe, expect, it, vi } from 'vitest';
import { buildPermissionRows } from '../src/core/permissions-onboarding.js';
import { CLI_PERMISSION_PREFLIGHT, decodePermissionProbe, permissionRequestScript, runPermissionsOnboarding, type PermissionsOnboardingDeps } from '../src/cli/permissions-onboarding.js';
import type { AuthoritySetupReportV1 } from '../src/core/authority/types.js';

function harness(overrides: Partial<PermissionsOnboardingDeps> = {}) {
  const report: AuthoritySetupReportV1 = {
    schema: 'ashlr.authority-setup.v1', dryRun: true, complete: false,
    summary: { done: 0, already: 0, waitingOnYou: 1, blocked: 0, failed: 0, planned: 0 }, next: 'standing-grant',
    steps: [{ id: 'standing-grant', step: 'standing grant', status: 'waiting-on-you', detail: 'Touch ID required', needs: ['touch-id'], command: 'phm authority grant', link: null }],
  };
  const deps = {
    platform: 'darwin', probe: vi.fn(async () => ({ accessibility: true, screen: false })),
    plan: vi.fn(async () => report), authority: vi.fn(async () => 0), openSettings: vi.fn(async () => undefined), request: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false), out: vi.fn(), err: vi.fn(), ...overrides,
  };
  return { deps, report };
}

describe('full permissions evidence', () => {
  it('reports public API truth and leaves unsupported grants unknown', () => {
    const rows = buildPermissionRows(decodePermissionProbe(JSON.stringify({ accessibility: true, screen: false, automationMessages: 0, automationSystemEvents: -1743 })));
    expect(rows.map(({ id, status }) => [id, status])).toEqual([
      ['accessibility', 'granted'], ['screen', 'missing'], ['automation-messages', 'granted'],
      ['automation-system-events', 'missing'], ['full-disk-access', 'unknown'], ['developer-tools', 'unknown'],
    ]);
  });
  it.each([-1744, -600, null, '0'])('does not invent successful AppleEvents evidence for %s', (code) => {
    const observed = decodePermissionProbe(JSON.stringify({ automationMessages: code }));
    expect(observed.automationMessages?.status).toBe(code === -1744 ? 'missing' : 'unknown');
    expect(observed.accessibility).toBeNull();
  });
  it('does not turn a non-macOS host or missing probe into granted permission', () => {
    expect(buildPermissionRows({}, 'linux').every((row) => row.status === 'unknown')).toBe(true);
    expect(buildPermissionRows().every((row) => row.status === 'unknown')).toBe(true);
    expect(() => decodePermissionProbe('null')).toThrow();
    expect(() => decodePermissionProbe('not JSON')).toThrow();
  });
  it('guides an unavailable AppleEvents target without treating it as denied', () => {
    const rows = buildPermissionRows(decodePermissionProbe('{"automationMessages":-600}'));
    expect(rows.find((row) => row.id === 'automation-messages')).toMatchObject({ status: 'unknown', reason: expect.stringContaining('Open the named app yourself') });
  });
  it.each([null, [], { accessibility: 'true', automationMessages: { status: 'invalid' } }])('narrows malformed native evidence at runtime', (observed) => {
    expect(buildPermissionRows(observed).every((row) => row.status === 'unknown')).toBe(true);
  });
  it('never accepts unsupported grant claims or exposes raw native diagnostics', () => {
    const rows = buildPermissionRows({ fullDiskAccess: { status: 'granted' }, developerTools: { status: 'granted' }, automationMessages: { status: 'unknown', reason: 'automation-unavailable-in-build' } });
    expect(rows.every((row) => row.status === 'unknown')).toBe(true);
    expect(rows.find((row) => row.id === 'automation-messages')?.reason).toContain('This app build cannot request');
    expect(JSON.stringify(rows)).not.toContain('automation-unavailable-in-build');
  });
  it('uses only nonprompting preflights for the two fixed automation targets', () => {
    expect(CLI_PERMISSION_PREFLIGHT).toContain('$.AXIsProcessTrusted()');
    expect(CLI_PERMISSION_PREFLIGHT).toContain('$.CGPreflightScreenCaptureAccess()');
    expect(CLI_PERMISSION_PREFLIGHT).toContain('desc.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false');
    expect(CLI_PERMISSION_PREFLIGHT).toContain("automation('com.apple.MobileSMS')");
    expect(CLI_PERMISSION_PREFLIGHT).toContain("automation('com.apple.systemevents')");
    expect(CLI_PERMISSION_PREFLIGHT).not.toMatch(/CGRequest|AXIsProcessTrustedWithOptions|AESend|TCC\.db|chat\.db/);
  });
});

describe('full permissions guide', () => {
  it.each(['--json', '--dry-run'])('%s cannot open settings, prompt or sign', async (flag) => {
    const { deps } = harness();
    expect(await runPermissionsOnboarding(['--full-permissions', flag], deps)).toBe(0);
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.authority).not.toHaveBeenCalled();
    if (flag === '--json') {
      expect(deps.out).toHaveBeenCalledTimes(1);
      expect(JSON.parse(deps.out.mock.calls[0]![0])).toMatchObject({ schema: 'phantom.permissions-onboarding.v1', scope: 'cli-probe', agents: { status: 'unknown' } });
    }
  });
  it('rejects bulk approval and unrecognized flags before even probing', async () => {
    const { deps } = harness();
    expect(await runPermissionsOnboarding(['--full-permissions', '--yes'], deps)).toBe(2);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.authority).not.toHaveBeenCalled();
  });
  it('offers only unresolved grants and opens nothing when declined', async () => {
    const { deps } = harness();
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.confirm.mock.calls.flat().join('\n')).not.toContain('Open Accessibility');
    expect(deps.openSettings).not.toHaveBeenCalled();
    expect(deps.authority).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
  });
  it('opens only the chosen fixed settings pane without marking it granted', async () => {
    const { deps } = harness({ confirm: vi.fn(async (question) => question.startsWith('Open Screen Recording')) });
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.openSettings).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    expect(deps.authority).not.toHaveBeenCalled();
  });
  it.each(['propose', 'autonomous'])('routes the selected %s level through unchanged grant signing', async (level) => {
    const { deps } = harness({ confirm: vi.fn(async (question) => question.toLowerCase().startsWith(`choose ${level}`)) });
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).toHaveBeenCalledExactlyOnceWith(['grant', '--switch', level]);
  });
  it('Off lowers through the existing command without signing', async () => {
    const { deps } = harness({ confirm: vi.fn(async (question) => question.startsWith('Choose Off')) });
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).toHaveBeenCalledExactlyOnceWith(['switch', 'off']);
  });
  it('does not re-prompt an already active grant', async () => {
    const { deps, report } = harness();
    report.steps[0]!.status = 'already';
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).not.toHaveBeenCalled();
  });
  it.each(['skipped', 'failed', 'blocked'] as const)('does not sign when a prior prerequisite leaves grant status %s', async (status) => {
    const { deps, report } = harness({ confirm: vi.fn(async () => true) });
    report.steps[0]!.status = status;
    report.next = 'custody-helper';
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).not.toHaveBeenCalled();
  });
  it('can review a grant when it is the next dry-run step', async () => {
    const { deps, report } = harness({ confirm: vi.fn(async (question) => question.startsWith('Choose Propose')) });
    report.steps[0]!.status = 'skipped';
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).toHaveBeenCalledExactlyOnceWith(['grant', '--switch', 'propose']);
  });
  it('lets an existing grant lower to Propose without signing again', async () => {
    const { deps, report } = harness({ confirm: vi.fn(async (question) => question.startsWith('A grant is already') || question.startsWith('Choose Propose')) });
    report.steps[0]!.status = 'already';
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.authority).toHaveBeenCalledExactlyOnceWith(['switch', 'propose']);
  });
  it('requests only the explicitly chosen permission after a fresh missing probe', async () => {
    const { deps } = harness({ confirm: vi.fn(async (question) => question.startsWith('Request macOS consent for Screen Recording')) });
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.request).toHaveBeenCalledExactlyOnceWith('screen');
    expect(deps.probe).toHaveBeenCalledTimes(3);
    expect(deps.openSettings).not.toHaveBeenCalled();
  });
  it.each([true, null])('does not request consent if the fresh preflight is %s', async (screen) => {
    const probe = vi.fn().mockResolvedValueOnce({ screen: false }).mockResolvedValue({ screen });
    const { deps } = harness({ probe, confirm: vi.fn(async (question) => question.startsWith('Request macOS consent for Screen Recording')) });
    await runPermissionsOnboarding(['--full-permissions'], deps);
    expect(deps.request).not.toHaveBeenCalled();
  });
  it('keeps consent APIs out of preflight and only builds allowlisted requests', () => {
    expect(permissionRequestScript('screen')).toContain('CGRequestScreenCaptureAccess');
    expect(permissionRequestScript('accessibility')).toContain('AXTrustedCheckOptionPrompt: true');
    expect(permissionRequestScript('automation-messages')).toContain("descriptorWithBundleIdentifier('com.apple.MobileSMS')");
    expect(permissionRequestScript('automation-system-events')).toContain('0x2a2a2a2a, 0x2a2a2a2a, true');
    expect(permissionRequestScript('full-disk-access')).toBeNull();
    expect(permissionRequestScript('developer-tools')).toBeNull();
  });
  it('preserves unknown evidence after failed probes instead of attempting recovery actions', async () => {
    const { deps } = harness({ probe: vi.fn(async () => { throw new Error('unavailable'); }), plan: vi.fn(async () => { throw new Error('unavailable'); }) });
    await runPermissionsOnboarding(['--full-permissions', '--json'], deps);
    const report = JSON.parse(deps.out.mock.calls[0]![0]);
    expect(report.authority).toBeNull();
    expect(report.permissions.every((row: { status: string }) => row.status === 'unknown')).toBe(true);
    expect(deps.authority).not.toHaveBeenCalled();
  });
});
