import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as contract from '../src/core/fleet/drop-job-contract.js';
import * as writer from '../src/core/fleet/drop-job-writer.js';
import * as browser from '../src/web-ui/routes/verse/mobile/screens/drop-job-model.js';
import { compareIngestSource } from '../src/core/fleet/ingest-drift.js';
import { runDoctor } from '../src/core/doctor.js';
import { defaultConfig } from '../src/core/config.js';

vi.mock('node:child_process', () => ({
  execFile: (_c: unknown, _a: unknown, _o: unknown, cb: (e: Error) => void) => {
    queueMicrotask(() => cb(new Error('fixture: unavailable')));
    return { stdin: { end() {} } };
  },
  spawnSync: () => ({ status: 1, stdout: '' }),
}));
vi.mock('../src/doctor/executable.js', () => ({ findDoctorExecutable: () => null }));
vi.mock('../src/core/phantom.js', () => ({ getPhantomStatus: () => ({ installed: false, initialized: false }) }));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: () => ({ servers: [] }) }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: () => ({ tools: [], installedCount: 0 }) }));
vi.mock('../src/core/providers.js', () => ({ getProviderRegistry: async () => ({ providers: [], chain: [] }) }));
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const job = { id: 'KEEP754S', lane: 'claude', tier: 'work', body: 'Preserve the original intake.' };
const source = String.raw`HEAD = re.compile(r'^#job repo=(phantom|phantom-secrets|ashlr-plugin|ashlr-stack|locus|lexicon|ashlr-md) lane=(\S+) tier=(\S+)\s*$')
ID = re.compile(r'^RQ-PHX-[A-Z0-9]{3,40}$')
LANES = ('claude', 'codex-personal', 'devin', 'codex-local')`;

it.each(['é', '界', '🦊', '\ud800', '\udc00'])('keeps Node UTF-8 limits without Buffer for %s', unit => {
  const budget = 8000 - Buffer.byteLength(contract.composeDropJobFile({ ...job, body: '' }));
  const body = unit.repeat(Math.floor(budget / Buffer.byteLength(unit)));
  const exact = body + 'x'.repeat(budget - Buffer.byteLength(body));
  const inputs = [exact, exact + 'x'].map(body => ({ ...job, body }));
  const expected = inputs.map(input => writer.validateDropJob(input));
  const saved = globalThis.Buffer;
  let actual;
  try {
    globalThis.Buffer = undefined as unknown as typeof Buffer;
    actual = inputs.map(input => [contract.validateDropJob(input), browser.validateDropJob(input), browser.dropJobBytes(input)]);
  } finally { globalThis.Buffer = saved; }
  expect(expected).toEqual([{ ok: true }, { ok: false, reasons: ['too-large'] }]);
  expect(actual).toEqual([
    [expected[0], { ok: true, payload: inputs[0] }, 8000],
    [expected[1], { ok: false, reason: 'too-large' }, 8001],
  ]);
});

it('shares headers, exports and rejection decisions across browser and backend', () => {
  expect(writer.validateDropJob).toBe(contract.validateDropJob);
  for (const repo of [...contract.DROP_JOB_REPOS, 'elsewhere']) {
    for (const body of [job.body, '', '\r', '.github/workflows', '/.codex', 'auth.json', 'CODEOWNERS']) {
      const input = { ...job, repo, body };
      const verdict = contract.validateDropJob(input);
      expect(browser.dropJobHeader(input.lane, input.tier, repo)).toBe(writer.dropJobHeader(input.lane, input.tier, repo));
      expect(browser.validateDropJob(input)).toEqual(verdict.ok ? { ok: true, payload: input } : { ok: false, reason: verdict.reasons[0] });
    }
  }
});

it.each([
  source.replace("\\s*$')", "\\s*$', re.I)"),
  source.replace("LANES = (", "LANES = ["),
  source.replace("'codex-local')", "'codex-local', computed)"),
  source + "\nID = dynamic_pattern",
  source + "\nif changed:\n    ID = dynamic_pattern",
  source.replace("{3,40}$')", "{3,40}$' + suffix)"),
  source.replace('LANES = ', '# LANES = '),
  `'''\n${source}\n'''`,
])('refuses ambiguous or unsupported source as unknown', text => {
  expect(compareIngestSource(text)).toMatchObject({ verdict: expect.stringMatching(/^unknown:/), fields: [] });
});

it('reports match, drift and unknown in the real doctor check list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'preserve-754s-')); roots.push(root);
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  mkdirSync(join(root, 'bin'));
  for (const [text, detail, status] of [
    [source, 'match', 'pass'],
    [source.replace('{3,40}', '{3,41}'), 'drift: ID', 'warn'],
    ['# unrecognised source', 'unknown: HEAD, ID, LANES not found in orch-ingest.py', 'warn'],
  ]) {
    writeFileSync(join(root, 'bin', 'orch-ingest.py'), text!);
    const report = await runDoctor(defaultConfig());
    expect(report.checks.filter(c => c.id === 'ingest-drift')).toEqual([expect.objectContaining({ status, detail })]);
  }
}, 60_000);
