import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { evalBudget } from '../src/core/observability/budget-alert.js';
import type { AshlrConfig } from '../src/core/types.js';

const probes = vi.hoisted(() => ({
  phantom: vi.fn(() => ({ installed: false, initialized: false })),
  providers: vi.fn(),
  genome: vi.fn(() => ({ totalEntries: 0, projects: 0, hubEntries: 0, sizeBytes: 0, lastLearnedAt: null, embeddingsAvailable: false })),
  spawn: vi.fn(() => ({ status: 1, stdout: '' })),
  command: vi.fn(),
  lookup: vi.fn(() => null),
  rollup: vi.fn(),
  governance: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawnSync: probes.spawn, execFile: (...args: unknown[]) => probes.command(...args) }));
vi.mock('../src/doctor/executable.js', () => ({ findDoctorExecutable: probes.lookup }));
vi.mock('../src/core/phantom.js', () => ({ getPhantomStatus: probes.phantom }));
vi.mock('../src/core/providers.js', () => ({ getProviderRegistry: probes.providers }));
vi.mock('../src/core/genome/store.js', () => ({ genomeHealth: probes.genome }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: () => ({ tools: [], installedCount: 0 }) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => ({ servers: [] }) }));
vi.mock('../src/core/integrations/identity.js', () => ({ getIdentity: () => null }));
vi.mock('../src/core/integrations/locus.js', () => ({
  locusAvailable: () => false, resolveLocusEnforceMode: () => 'warn',
}));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollupAsync: probes.rollup }));
vi.mock('../src/core/observability/governance.js', () => ({ evalGovernance: probes.governance }));
vi.mock('../src/core/observability/telemetry-sink.js', () => ({ patAvailable: () => false }));
vi.mock('../src/core/receipt/receipt-store.js', () => ({ receiptStatus: () => ({ receipts: 0, latest: null }) }));
vi.mock('../src/core/readiness.js', () => ({
  readEnrollmentState: () => ({ count: 0 }), readDaemonHealth: () => ({ running: false }),
  readKillState: () => ({ on: false }), checkAshlrWriteable: () => true,
  readSandboxHealth: () => ({ total: 0, orphans: 0, cap: 1, capReason: 'test' }),
  readGitLockHealth: () => ({ repos: 0, locks: [] }), SANDBOX_ORPHAN_WARN_THRESHOLD: 3,
}));

import { runDoctor } from '../src/core/doctor.js';

beforeEach(() => {
  vi.clearAllMocks();
  probes.command.mockImplementation((_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    queueMicrotask(() => callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', ''));
    return { stdin: { end: vi.fn() } };
  });
  probes.rollup.mockResolvedValue(null);
  probes.governance.mockReturnValue(null);
  probes.providers.mockResolvedValue({ providers: [{ id: 'ollama', models: ['nomic-embed-text'], up: true, url: 'http://localhost:11434/api/tags' }], activeProvider: 'ollama', chain: ['ollama'] });
});

describe('doctor invocation snapshots', () => {
  it('shares Phantom status, PATH lookup and Ollama models without caching across runs', async () => {
    const cfg = defaultConfig();
    for (let run = 1; run <= 2; run++) {
      const report = await runDoctor(cfg);
      expect(probes.phantom).toHaveBeenCalledTimes(run);
      expect(probes.providers).toHaveBeenCalledTimes(run);
      expect(probes.genome).toHaveBeenLastCalledWith(cfg, { ollamaModels: ['nomic-embed-text'] });
      if (process.platform === 'win32') {
        expect(probes.command.mock.calls.filter(args => (args as unknown[])[1]?.toString() === 'phm')).toHaveLength(run);
      } else {
        expect(probes.lookup.mock.calls.filter(args => (args as unknown[])[0] === 'phm')).toHaveLength(run);
        expect(probes.command.mock.calls.some(args => (args as unknown[])[1]?.toString() === 'phm')).toBe(false);
      }
      expect(report.checks.find(check => check.id === 'phantom-preflight')?.detail).toContain('skipped');
      expect(report.checks.find(check => check.id === 'provider:active')?.status).toBe('pass');
      expect(report.summary.pass + report.summary.warn + report.summary.fail).toBe(report.checks.length);
    }
  });

  it('retains registry failure reporting and standalone genome probing on a rejected registry', async () => {
    probes.providers.mockRejectedValue(new Error('unavailable'));
    const cfg = defaultConfig();
    const report = await runDoctor(cfg);
    expect(probes.genome).toHaveBeenCalledWith(cfg, undefined);
    expect(report.checks.find(check => check.id === 'provider:registry')?.status).toBe('fail');
  });

  it('does not collect usage or load governance for an uncapped budget', async () => {
    probes.rollup.mockRejectedValue(new Error('must not collect uncapped usage'));
    probes.governance.mockImplementation(() => { throw new Error('must not evaluate uncapped governance'); });
    const cfg = defaultConfig();
    cfg.telemetry = { budgetWindow: '30d' };
    const report = await runDoctor(cfg);
    expect(probes.rollup).not.toHaveBeenCalled();
    expect(probes.governance).not.toHaveBeenCalled();
    expect(report.checks.find(check => check.id === 'budget-spend')).toMatchObject({ status: 'pass', detail: 'No budget cap configured for 30d window' });
    expect(report.checks.find(check => check.id === 'spend-governance')).toMatchObject({ status: 'pass', detail: 'No spend cap configured (window: 30d)' });
  });

  it.each([
    { cap: 'budgetUsd' as const, value: 1, governanceCalls: 1 },
    { cap: 'budgetTokens' as const, value: 10, governanceCalls: 0 },
    { cap: 'budgetUsd' as const, value: 0, governanceCalls: 1 },
  ])('keeps configured $cap=$value evaluation and over-budget failures', async ({ cap, value, governanceCalls }) => {
    probes.rollup.mockImplementation(async (window: string, cfg: AshlrConfig) => ({ budget: evalBudget({ spentUsd: 2, spentTokens: 20 }, cfg, window) }));
    probes.governance.mockReturnValue({ level: 'over', spentUsd: 2, capUsd: value, window: '1d', message: 'Configured spend cap exceeded' });
    const cfg = defaultConfig();
    cfg.telemetry = { budgetWindow: '1d', [cap]: value };
    const report = await runDoctor(cfg);
    expect(probes.rollup).toHaveBeenCalledExactlyOnceWith('1d', cfg);
    expect(probes.governance).toHaveBeenCalledTimes(governanceCalls);
    expect(report.checks.find(check => check.id === 'budget-spend')?.status).toBe('fail');
    expect(report.checks.find(check => check.id === 'spend-governance')?.status).toBe(governanceCalls ? 'fail' : 'pass');
  });

  it('rechecks budget configuration and usage on every invocation', async () => {
    probes.rollup.mockImplementation(async (window: string, cfg: AshlrConfig) => ({ budget: evalBudget({ spentUsd: 2, spentTokens: 20 }, cfg, window) }));
    probes.governance.mockReturnValue({ level: 'over', spentUsd: 2, capUsd: 1, window: '7d', message: 'Configured spend cap exceeded' });
    const cfg = defaultConfig();
    cfg.telemetry = {};
    const uncapped = await runDoctor(cfg);
    expect(uncapped.checks.find(check => check.id === 'budget-spend')?.status).toBe('pass');
    expect(probes.rollup).not.toHaveBeenCalled();
    cfg.telemetry.budgetUsd = 1;
    const capped = await runDoctor(cfg);
    expect(capped.checks.find(check => check.id === 'budget-spend')?.status).toBe('fail');
    expect(probes.rollup).toHaveBeenCalledTimes(1);
    delete cfg.telemetry.budgetUsd;
    cfg.telemetry.budgetTokens = 10;
    const tokenCapped = await runDoctor(cfg);
    expect(tokenCapped.checks.find(check => check.id === 'budget-spend')?.status).toBe('fail');
    expect(probes.rollup).toHaveBeenCalledTimes(2);
    expect(probes.governance).toHaveBeenCalledTimes(1);
  });

  it('preserves unavailable-module diagnostics when configured budget probes fail', async () => {
    probes.rollup.mockRejectedValue(new Error('usage unavailable'));
    probes.governance.mockImplementation(() => { throw new Error('governance unavailable'); });
    const cfg = defaultConfig();
    cfg.telemetry = { budgetUsd: 1 };
    const report = await runDoctor(cfg);
    expect(probes.rollup).toHaveBeenCalledOnce();
    expect(probes.governance).toHaveBeenCalledOnce();
    expect(report.checks.find(check => check.id === 'budget-spend')).toMatchObject({ status: 'pass', detail: 'Observability module not yet available — skipping budget check' });
    expect(report.checks.find(check => check.id === 'spend-governance')).toMatchObject({ status: 'pass', detail: 'Governance module not yet available — skipping' });
  });

});
