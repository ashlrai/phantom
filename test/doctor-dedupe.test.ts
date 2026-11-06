import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';

const probes = vi.hoisted(() => ({
  phantom: vi.fn(() => ({ installed: false, initialized: false })),
  providers: vi.fn(),
  genome: vi.fn(() => ({ totalEntries: 0, projects: 0, hubEntries: 0, sizeBytes: 0, lastLearnedAt: null, embeddingsAvailable: false })),
  spawn: vi.fn(() => ({ status: 1, stdout: '' })),
}));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: probes.spawn,
}));
vi.mock('../src/core/phantom.js', () => ({ getPhantomStatus: probes.phantom }));
vi.mock('../src/core/providers.js', () => ({ getProviderRegistry: probes.providers }));
vi.mock('../src/core/genome/store.js', () => ({ genomeHealth: probes.genome }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: () => ({ tools: [], installedCount: 0 }) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => ({ servers: [] }) }));
vi.mock('../src/core/integrations/identity.js', () => ({ getIdentity: () => null }));
vi.mock('../src/core/integrations/locus.js', () => ({
  locusAvailable: () => false, resolveLocusEnforceMode: () => 'warn',
}));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: () => null }));
vi.mock('../src/core/observability/governance.js', () => ({ evalGovernance: () => null }));
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
      expect(probes.spawn.mock.calls.filter(args => (args as unknown[])[1]?.toString() === 'phm')).toHaveLength(run);
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
});
