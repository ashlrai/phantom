/**
 * cli-json-first-run.test.ts — `--json` on the first-run commands agents drive
 * non-interactively: `onboard`, `enroll add`, `mcp ecosystem`, `docs`.
 *
 * Contract: with `--json`, stdout carries exactly one JSON object (no ANSI, no
 * prose), the exit code matches the human path, and nothing prompts. Without
 * the flag the human output is unchanged (non-JSON).
 *
 * Hermetic: readiness/stack/daemon/policy/config are mocked; the ecosystem case
 * uses a throwaway HOME + PATH with an inert native-header fixture (never run).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  readiness: vi.fn(),
  stackInstalled: vi.fn(() => false),
  stackStatus: vi.fn(() => ({ ok: false, detail: 'stack not installed' })),
  stackProjectConfigured: vi.fn(() => false),
  tick: vi.fn(async () => ({ ts: '', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'dry-run' })),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  setKill: vi.fn(),
  listEnrolled: vi.fn((): string[] => []),
  canonicalEnrollmentPath: vi.fn((p: string): string | null => p),
  readEnrollmentRegistry: vi.fn(),
  killSwitchOn: vi.fn(() => false),
  sweep: vi.fn(),
}));

vi.mock('../src/core/readiness.js', () => ({ buildReadiness: mocks.readiness }));
vi.mock('../src/core/integrations/stack.js', () => ({
  stackInstalled: mocks.stackInstalled,
  stackStatus: mocks.stackStatus,
  stackProjectConfigured: mocks.stackProjectConfigured,
}));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: mocks.tick }));
vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/config.js')>(),
  loadConfig: () => ({}),
}));
vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  enroll: mocks.enroll,
  unenroll: mocks.unenroll,
  setKill: mocks.setKill,
  listEnrolled: mocks.listEnrolled,
  canonicalEnrollmentPath: mocks.canonicalEnrollmentPath,
  readEnrollmentRegistry: mocks.readEnrollmentRegistry,
  killSwitchOn: mocks.killSwitchOn,
}));
vi.mock('../src/core/sandbox/worktree.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/worktree.js')>(),
  sweepRepoSandboxesDetailed: mocks.sweep,
}));

import { cmdOnboard, _internals } from '../src/cli/onboard.js';
import { cmdEnroll } from '../src/cli/sandbox.js';
import { cmdMcp } from '../src/cli/mcp.js';
import { cmdDocs } from '../src/cli/help.js';
import { _firmOfferInternals } from '../src/cli/locus-firm-offer.js';

const OK_MUTATION = { ok: true, quiesced: true, reason: 'ok' };
const origIsTTY = process.stdin.isTTY;
const origFirm = { ..._firmOfferInternals };
const tmpRoots: string[] = [];

interface Captured { code: number; stdout: string; stderr: string }

/** Run a command, capturing stdout (console.log + process.stdout.write) and stderr. */
async function capture(run: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...v: unknown[]) => { out.push(v.map(String).join(' ') + '\n'); });
  vi.spyOn(console, 'error').mockImplementation((...v: unknown[]) => { err.push(v.map(String).join(' ') + '\n'); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const code = await run();
  vi.restoreAllMocks();
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function parseOne(stdout: string): Record<string, unknown> {
  expect(stdout).not.toContain('\u001b');
  const parsed: unknown = JSON.parse(stdout);
  expect(parsed).toBeTypeOf('object');
  return parsed as Record<string, unknown>;
}

function setTty(on: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: on, configurable: true });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.readiness.mockResolvedValue({ ready: true, blockers: [], warnings: [], info: [], generatedAt: '' });
  mocks.stackInstalled.mockReturnValue(false);
  mocks.listEnrolled.mockReturnValue([]);
  mocks.canonicalEnrollmentPath.mockImplementation((p: string) => p);
  mocks.killSwitchOn.mockReturnValue(false);
  mocks.readEnrollmentRegistry.mockReturnValue({ state: 'ready', repos: [], reason: 'ok' });
  _firmOfferInternals.locusAvailable = () => false;
});

afterEach(() => {
  setTty(origIsTTY);
  Object.assign(_firmOfferInternals, origFirm);
  vi.unstubAllEnvs();
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('onboard --json', () => {
  it('emits the steps as one JSON object and never prompts, even on a TTY', async () => {
    setTty(true);
    const confirm = vi.fn(async () => true);
    _internals.confirm = confirm;
    const r = await capture(() => cmdOnboard(['/tmp/some-repo', '--json']));
    expect(r.code).toBe(0);
    const obj = parseOne(r.stdout);
    expect(obj).toMatchObject({ ok: true, mode: 'steps', ready: true, repo: '/tmp/some-repo', enrolled: false });
    const steps = obj['steps'] as Array<{ name: string; command: string }>;
    expect(steps.map((s) => s.name)).toEqual(['preflight', 'enroll', 'dry-run', 'review', 'rollback']);
    expect(steps[1]?.command).toBe('ashlr enroll add /tmp/some-repo');
    expect(obj['locusFirm']).toMatchObject({ decision: 'locus-absent' });
    expect(obj['stack']).toEqual({ installed: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(mocks.enroll).not.toHaveBeenCalled();
  });

  it('routes firm-offer prose to stderr so stdout stays JSON', async () => {
    _firmOfferInternals.locusAvailable = () => true;
    _firmOfferInternals.loadConfig = () => ({}) as never;
    _firmOfferInternals.saveConfig = vi.fn();
    const r = await capture(() => cmdOnboard(['/tmp/r', '--json', '--locus-firm']));
    expect(r.code).toBe(0);
    expect(parseOne(r.stdout)['locusFirm']).toMatchObject({ decision: 'set' });
    expect(r.stderr).toContain('locus.firm=true');
  });

  it('reports preflight blockers as JSON with the same exit code 1', async () => {
    mocks.readiness.mockResolvedValue({
      ready: false,
      blockers: [{ id: 'ashlr-writeable', severity: 'blocker', detail: 'not writeable' }],
      warnings: [], info: [], generatedAt: '',
    });
    const r = await capture(() => cmdOnboard(['--json']));
    expect(r.code).toBe(1);
    const obj = parseOne(r.stdout);
    expect(obj).toMatchObject({ ok: false, mode: 'preflight', ready: false });
    expect(obj['blockers']).toEqual([{ id: 'ashlr-writeable', severity: 'blocker', detail: 'not writeable' }]);
  });

  it('reports rollback facts as JSON with the human exit code', async () => {
    mocks.unenroll.mockReturnValue(OK_MUTATION);
    mocks.setKill.mockReturnValue(OK_MUTATION);
    mocks.sweep.mockReturnValue({
      completed: ['sb-1'], residual: [], refused: [], unavailable: [], unexpectedErrors: [],
      inventory: { malformedHomes: 0, unsafeEntries: 0 },
    });
    const r = await capture(() => cmdOnboard(['--rollback', '/tmp/r', '--kill', '--json']));
    expect(r.code).toBe(0);
    expect(parseOne(r.stdout)).toMatchObject({
      ok: true, mode: 'rollback', repo: '/tmp/r', unenrolled: true, swept: ['sb-1'],
      incompleteCleanups: 0, kill: { requested: true, confirmed: true },
    });

    mocks.unenroll.mockReturnValue({ ok: false, quiesced: false, reason: 'degraded' });
    const failed = await capture(() => cmdOnboard(['--rollback', '/tmp/r', '--json']));
    expect(failed.code).toBe(1);
    expect(parseOne(failed.stdout)).toMatchObject({ ok: false, unenrolled: false, kill: null });
  });

  it('keeps the human steps output without --json', async () => {
    const r = await capture(() => cmdOnboard(['/tmp/r', '--yes']));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('first safe activation (steps)');
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});

describe('enroll add --json', () => {
  it('emits the enrollment result as one JSON object', async () => {
    setTty(true);
    mocks.enroll.mockReturnValue(OK_MUTATION);
    const r = await capture(() => cmdEnroll(['add', '/tmp/r', '--json']));
    expect(r.code).toBe(0);
    expect(parseOne(r.stdout)).toMatchObject({
      ok: true, repo: '/tmp/r', enrolled: true, firstEnrollment: true,
      locusFirm: { decision: 'locus-absent' },
    });
  });

  it('does not prompt for the firm profile under --json on a TTY', async () => {
    setTty(true);
    _firmOfferInternals.locusAvailable = () => true;
    _firmOfferInternals.loadConfig = () => ({}) as never;
    const confirm = vi.fn(async () => true);
    _firmOfferInternals.confirm = confirm;
    mocks.enroll.mockReturnValue(OK_MUTATION);
    const r = await capture(() => cmdEnroll(['add', '/tmp/r', '--json']));
    expect(r.code).toBe(0);
    expect(parseOne(r.stdout)['locusFirm']).toMatchObject({ decision: 'skip' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports failures and usage errors as JSON with unchanged exit codes', async () => {
    mocks.enroll.mockReturnValue({ ok: false, quiesced: false, reason: 'policy storage unsafe' });
    const failed = await capture(() => cmdEnroll(['add', '/tmp/r', '--json']));
    expect(failed.code).toBe(1);
    expect(parseOne(failed.stdout)).toMatchObject({ ok: false, repo: '/tmp/r' });

    const usage = await capture(() => cmdEnroll(['add', '--json']));
    expect(usage.code).toBe(2);
    expect(parseOne(usage.stdout)['error']).toMatch(/^Usage: ashlr enroll add/);
  });

  it('keeps the human line without --json', async () => {
    mocks.enroll.mockReturnValue(OK_MUTATION);
    const r = await capture(() => cmdEnroll(['add', '/tmp/r', '--yes']));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Enrolled:');
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});

describe('mcp ecosystem --json', () => {
  function fixture(): { root: string; bin: string } {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phm-eco-json-')));
    tmpRoots.push(root);
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
    vi.stubEnv('LOCUS_HOME', path.join(root, 'locus-home'));
    const binDir = path.join(root, 'bin');
    fs.mkdirSync(binDir);
    const bin = path.join(binDir, process.platform === 'win32' ? 'phantom.exe' : 'phantom');
    // Inert native (Mach-O) header: detection reads it, never runs it.
    fs.writeFileSync(bin, Buffer.from('cffaedfe00000000', 'hex'));
    fs.chmodSync(bin, 0o700);
    vi.stubEnv('PATH', binDir);
    return { root, bin: fs.realpathSync(bin) };
  }

  it('lists available/missing servers and registration state as JSON', async () => {
    const { root, bin } = fixture();
    const r = await capture(() => cmdMcp(['ecosystem', '--json']));
    expect(r.code).toBe(0);
    const obj = parseOne(r.stdout);
    expect(obj).toMatchObject({ ok: true, write: false, added: [], settingsPath: path.join(root, '.ashlr', 'settings.json') });
    expect(obj['available']).toEqual([{
      name: 'phantom-secrets', label: 'Phantom Secrets (phantom-mcp)', probe: 'phantom',
      command: bin, args: ['mcp', 'serve'], registered: false,
    }]);
    expect(obj['missing']).toEqual([{ name: 'locus', label: 'Locus (identity plane)', probe: 'locus-mcp' }]);
  });

  it('--write --json registers and reports the added servers', async () => {
    const { root } = fixture();
    const r = await capture(() => cmdMcp(['ecosystem', '--write', '--json']));
    expect(r.code).toBe(0);
    expect(parseOne(r.stdout)).toMatchObject({ ok: true, write: true, added: ['phantom-secrets'] });
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.ashlr', 'settings.json'), 'utf8'));
    expect(Object.keys(settings.mcpServers)).toEqual(['phantom-secrets']);
  });

  it('reports unreadable settings as JSON with exit 1', async () => {
    const { root } = fixture();
    fs.mkdirSync(path.join(root, '.ashlr'));
    fs.writeFileSync(path.join(root, '.ashlr', 'settings.json'), '{not json');
    const r = await capture(() => cmdMcp(['ecosystem', '--json']));
    expect(r.code).toBe(1);
    expect(parseOne(r.stdout)).toMatchObject({ ok: false });
  });

  it('keeps the human view without --json', async () => {
    fixture();
    const r = await capture(() => cmdMcp(['ecosystem']));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ashlr mcp ecosystem');
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});

describe('docs --json', () => {
  it('without --agent emits a JSON error naming the surfaces, exit 2', async () => {
    const r = await capture(() => cmdDocs(['--json']));
    expect(r.code).toBe(2);
    const obj = parseOne(r.stdout);
    expect(obj).toMatchObject({ ok: false });
    expect((obj['surfaces'] as Array<{ command: string }>).map((s) => s.command))
      .toContain('ashlr docs --agent --json');
  });

  it('keeps the human help (exit 2) without --json', async () => {
    const r = await capture(() => cmdDocs([]));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('ashlr docs');
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});
