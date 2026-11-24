import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { DROP_JOB_LANES, INGEST_JOB_HEADER, INGEST_JOB_ID } from '../src/core/fleet/drop-job-writer.js';

const probes = vi.hoisted(() => ({ ingest: vi.fn(), command: vi.fn() }));
vi.mock('../src/core/fleet/ingest-drift.js', async original => ({
  ...await original<typeof import('../src/core/fleet/ingest-drift.js')>(),
  checkIngestDrift: probes.ingest,
}));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => probes.command(...args),
}));
vi.mock('../src/doctor/executable.js', () => ({ findDoctorExecutable: () => null }));
vi.mock('../src/core/phantom.js', () => ({ getPhantomStatus: () => ({ installed: false, initialized: false }) }));
vi.mock('../src/core/providers.js', () => ({ getProviderRegistry: () => ({ providers: [], activeProvider: null }) }));
vi.mock('../src/core/genome/store.js', () => ({ genomeHealth: () => null }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: () => ({ tools: [], installedCount: 0 }) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => ({ servers: [] }) }));
vi.mock('../src/core/integrations/identity.js', () => ({ getIdentity: () => null }));
vi.mock('../src/core/integrations/locus.js', () => ({ locusAvailable: () => false, resolveLocusEnforceMode: () => 'warn' }));
vi.mock('../src/core/companion-inventory.js', () => ({ companionExecutableState: () => 'missing' }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollupAsync: () => null }));
vi.mock('../src/core/observability/governance.js', () => ({ evalGovernance: () => null }));
vi.mock('../src/core/observability/telemetry-sink.js', () => ({ patAvailable: () => false }));
vi.mock('../src/core/resources/pool-cli-doctor.js', () => ({ checkPoolCliVersions: () => [] }));
vi.mock('../src/core/run/local-inference-probe.js', () => ({ probeLocalInference: () => ({ status: 'not-configured' }) }));
vi.mock('../src/core/receipt/receipt-store.js', () => ({ receiptStatus: () => ({ receipts: 0, latest: null }) }));
vi.mock('../src/core/inbox/temp-worktree-reaper.js', () => ({ readTempWorktreeStorage: () => ({ bytes: 0, worktrees: 0 }) }));
vi.mock('../src/core/readiness.js', () => ({
  readEnrollmentState: () => ({ count: 0 }), readDaemonHealth: () => ({ running: false }),
  readKillState: () => ({ on: false }), checkAshlrWriteable: () => true,
  readSandboxHealth: () => ({ total: 0, orphans: 0, cap: 1, capReason: 'test' }),
  readGitLockHealth: () => ({ repos: 0, locks: [] }), SANDBOX_ORPHAN_WARN_THRESHOLD: 3,
}));

import { checkIngestDriftDoctor, runDoctor } from '../src/core/doctor.js';
const { compareIngestSource, checkIngestDrift, INGEST_MISSING, defaultIngestPath } =
  await vi.importActual<typeof import('../src/core/fleet/ingest-drift.js')>('../src/core/fleet/ingest-drift.js');
const source = [
  `HEAD = re.compile(r'${INGEST_JOB_HEADER.source}')`,
  `ID = re.compile(r'${INGEST_JOB_ID.source}')`,
  `LANES = (${DROP_JOB_LANES.map(l => `'${l}'`).join(', ')})`,
].join('\n');
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function unknown(text: string) {
  const report = compareIngestSource(text);
  expect(report.verdict).toMatch(/^unknown:/);
  expect(report.fields).toEqual([]);
}

describe('preserved inert ingest contract reader', () => {
  it('matches the existing writer exports and compares all fields', () => {
    const report = compareIngestSource(source);
    expect(report.verdict).toBe('match');
    expect(report.fields.map(f => f.field)).toEqual(['HEAD', 'ID', 'LANES']);
    expect(report.fields.every(f => f.same && f.ours === f.host)).toBe(true);
  });
  it.each(['HEAD', 'ID', 'LANES'] as const)('names %s drift', field => {
    const changed = source.replace(new RegExp(`^${field}.*$`, 'm'), () => field === 'LANES' ? "LANES = ('other',)" : `${field} = r'^different$'`);
    const report = compareIngestSource(changed);
    expect(report.verdict).toBe(`drift: ${field}`);
    expect(report.fields.filter(f => !f.same).map(f => f.field)).toEqual([field]);
  });
  it.each(['[', '{', '('])('accepts static %s lane containers, order and comments', open => {
    const close = { '[': ']', '{': '}', '(': ')' }[open];
    expect(compareIngestSource(source.replace(/^LANES.*$/m, `LANES = ${open}${[...DROP_JOB_LANES].reverse().map(l => `"${l}"`).join(', ')},${close} # static`)).verdict).toBe('match');
  });
  it.each([
    '', 'HEAD = dynamic()\nID = dynamic()\nLANES = dynamic()',
    `${source}\nHEAD = r'other'`, `${source}\nHEAD: str = r'other'`,
    `${source}\nID += r'other'`, `${source}\nLANES, other = ('other',), None`, `${source}\nif enabled: ID = r'other'`,
    source.replace('HEAD =', 'if enabled: HEAD ='), source.replace('ID =', 'if enabled:\n  ID ='),
    source.replace('LANES =', 'if enabled:\n  LANES ='), `${source}\nLANES = ('other',)`,
    source.replace("')\nID", "', re.I)\nID"),
    source.replace("')\nID", "' + r'')\nID"), source.replace("')\nID", "') if enabled else r'other'\nID"),
    source.replace('LANES = (', 'LANES = [').replace(/\)$/, '}'),
    source.replace('LANES = (', 'LANES = (\n'),
    source.replace('HEAD = re.compile(', 'HEAD = re.compile(\n'),
    `"""\n${source}\n"""`, `container = (\n${source}\n)`, `${source}\\\n`, `${source}\nID = r'other'; ID = r'again'`,
    source.replace(/^LANES.*$/m, "LANES = ('claude', 'claude')"),
  ])('returns unknown for unsupported or ambiguous source %#', text => unknown(text));
  it('reads only supplied temporary files; missing and unreadable remain unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'ingest-769s-')); roots.push(root);
    const file = join(root, 'fake.py'); writeFileSync(file, source);
    expect(checkIngestDrift(file).verdict).toBe('match');
    expect(checkIngestDrift(join(root, 'missing.py'))).toEqual({ verdict: INGEST_MISSING, fields: [] });
    expect(checkIngestDrift(root)).toEqual({ verdict: 'unknown: orch-ingest.py unreadable', fields: [] });
    expect(() => checkIngestDrift(join(root, 'missing.py'))).not.toThrow();
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    expect(defaultIngestPath()).toBe(join(root, 'bin', 'orch-ingest.py'));
  });
});

describe('preserved real doctor registration', () => {
  it.each([
    ['match', 'pass'], ['drift: HEAD', 'warn'], ['drift: ID', 'warn'], ['drift: LANES', 'warn'],
    [INGEST_MISSING, 'pass'], ['unknown: orch-ingest.py unreadable', 'warn'],
  ] as const)('%s retains %s policy in runDoctor', async (verdict, status) => {
    probes.ingest.mockReturnValue({ verdict, fields: [] });
    probes.command.mockImplementation((_cmd, _args, _opts, callback) => {
      callback(new Error('synthetic missing command'), '', ''); return { stdin: { end() {} } };
    });
    const network = vi.fn(() => { throw new Error('unexpected transport'); }); vi.stubGlobal('fetch', network);
    const report = await runDoctor(defaultConfig());
    expect(report.checks.filter(c => c.id === 'ingest-drift')).toEqual([
      expect.objectContaining({ label: 'Host ingest contract', status, detail: verdict }),
    ]);
    if (verdict.startsWith('drift:')) expect(report.checks.find(c => c.id === 'ingest-drift')?.fix).toMatch(/^Review/);
    expect(network).not.toHaveBeenCalled();
    expect(probes.ingest).toHaveBeenCalled();
  });
  it('degrades a failed probe without leaking exception details', () => {
    expect(checkIngestDriftDoctor(() => { throw new Error('private detail'); })).toEqual({
      id: 'ingest-drift', label: 'Host ingest contract', status: 'warn', detail: 'unknown: could not compare',
    });
  });
});
