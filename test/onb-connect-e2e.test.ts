/**
 * onb-connect-e2e.test.ts — RQ-ONB-CONNECT-E2E
 *
 * END-TO-END walk of the ONB-1..9 first-run journey against a LOCAL MOCK of
 * https://phm.dev/connect. The connect page is the hosted entry point of the
 * Phantom onboarding journey: it hands a new user the install command, the
 * `phm --version` check and the ordered ONB-1..9 step list. This suite binds a
 * loopback http server in for that endpoint and then walks every declared
 * step against the REAL workbench code paths — the real CLI, first-run
 * bootstrap, preflight, the explicit enroll gate, the dry-run plan, inbox
 * review, the global stop and the one-command rollback.
 *
 * WHAT IS PINNED (the connect contract, until phm.dev/connect ships):
 *   - GET /connect returns a v1 manifest naming @ashlr/phantom, `phm --version`
 *     and exactly nine steps ONB-1..9 in order.
 *   - The product-side gates the manifest advertises behave as the local code
 *     implements them — nothing auto-applies, nothing spends, undo is inward.
 *
 * SAFETY:
 *   - HOME/USERPROFILE/ASHLR_HOME relocated to a tmp dir for the whole suite;
 *     every ~/.ashlr read/write is isolated.
 *   - NETWORK: the only outbound traffic is loopback fetch to the mock
 *     (127.0.0.1, ephemeral port). The onboarding code under test only ever
 *     probes loopback model endpoints (ECONNREFUSED is a warning, never a
 *     blocker), so no external endpoint is contacted.
 *   - DISPOSABLE git repos under the tmp home. Spawned processes are the real
 *     `phm --version` CLI and git itself — this file belongs to the real-io
 *     lane (see test/config/realio-lane-membership.mjs).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { AshlrConfig } from '../src/core/types.js';
import { shasumTree, todoScannerAvailable } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// The ONB-1..9 contract the connect page serves. `gate` names each step's
// blast radius: 'hosted' reads phm.dev only; 'read-only' never mutates;
// 'explicit-human' needs the operator's own command; 'review' lists but never
// applies; 'inward-only' narrows state.
// ---------------------------------------------------------------------------

interface OnbStep {
  id: string;
  title: string;
  command: string | null;
  gate: 'hosted' | 'local-ensure' | 'read-only' | 'explicit-human' | 'review' | 'inward-only';
}

const ONB_STEPS: readonly OnbStep[] = [
  { id: 'ONB-1', title: 'Connect to Phantom', command: null, gate: 'hosted' },
  { id: 'ONB-2', title: 'Verify the installed CLI', command: 'phm --version', gate: 'read-only' },
  { id: 'ONB-3', title: 'First-run bootstrap', command: 'phm init', gate: 'local-ensure' },
  { id: 'ONB-4', title: 'Preflight readiness', command: 'phm preflight', gate: 'read-only' },
  { id: 'ONB-5', title: 'Enroll one repository', command: 'phm enroll add <repo>', gate: 'explicit-human' },
  { id: 'ONB-6', title: 'Dry-run plan preview', command: 'phm daemon start --dry-run --once', gate: 'read-only' },
  { id: 'ONB-7', title: 'Review the inbox', command: 'phm inbox', gate: 'review' },
  { id: 'ONB-8', title: 'The global stop', command: 'phm enroll kill on', gate: 'explicit-human' },
  { id: 'ONB-9', title: 'One-command rollback', command: 'phm onboard --rollback <repo>', gate: 'inward-only' },
];

// ---------------------------------------------------------------------------
// Local mock of phm.dev — serves / and /connect, 404s everything else.
// ---------------------------------------------------------------------------

function connectManifest(): Record<string, unknown> {
  return {
    v: 1,
    product: 'phantom',
    page: '/connect',
    generatedAt: '2026-10-28T00:00:00.000Z',
    install: 'npm install -g @ashlr/phantom',
    verify: 'phm --version',
    steps: ONB_STEPS,
  };
}

interface ConnectMock {
  origin: string;
  hits: string[];
  server: Server;
}

function startConnectMock(): Promise<ConnectMock> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    hits.push(`${req.method} ${url.pathname}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>Phantom</title>' +
          '<a href="/connect">Connect your workbench</a>',
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/connect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(connectManifest()));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ origin: `http://127.0.0.1:${port}`, hits, server });
    });
  });
}

/** Strict shape check: returns the manifest narrowed, fails the test otherwise. */
function expectManifest(body: unknown): { steps: OnbStep[]; install: string } {
  expect(typeof body).toBe('object');
  const m = body as Record<string, unknown>;
  expect(m['v']).toBe(1);
  expect(m['product']).toBe('phantom');
  expect(m['page']).toBe('/connect');
  expect(m['install']).toBe('npm install -g @ashlr/phantom');
  expect(m['verify']).toBe('phm --version');
  const steps = m['steps'];
  expect(Array.isArray(steps)).toBe(true);
  const list = steps as OnbStep[];
  expect(list).toHaveLength(9);
  list.forEach((s, i) => {
    expect(s.id).toBe(`ONB-${i + 1}`);
    expect(typeof s.title).toBe('string');
    expect(s.title.length).toBeGreaterThan(0);
    expect(['hosted', 'read-only', 'explicit-human', 'review', 'inward-only', 'local-ensure']).toContain(s.gate);
  });
  return { steps: list, install: String(m['install']) };
}

// ---------------------------------------------------------------------------
// Disposable git repo under a caller-chosen parent (realpath'd tmp home).
// ---------------------------------------------------------------------------

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function makeRepo(parent: string, name: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--initial-branch=main', '.']);
  git(dir, ['config', 'user.email', 'onb@ashlr.test']);
  git(dir, ['config', 'user.name', 'ONB Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'README.md'), '# disposable ONB repo\n');
  // A first-party-source TODO marker gives the real scanner a deterministic
  // discovery signal for the dry-run plan (scanTodos only reads src/, lib/,
  // app/, packages/*/src — see scanners.ts isFirstPartySourcePath).
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'todo-note.ts'),
    'export const marker = 1;\n// TODO: onb-e2e-marker — deterministic discovery signal\n',
  );
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', 'init']);
  return dir;
}

// ---------------------------------------------------------------------------
// The walk — nine ordered steps, one assertion surface each. State flows
// through the describe (enroll persists into dry-run; rollback closes it).
// ---------------------------------------------------------------------------

describe('ONB-1..9 — end-to-end onboarding walk vs local phm.dev/connect mock', () => {
  let tmpHome = '';
  let codeRoot = '';
  let repoDir = '';
  let pendingBefore = -1;
  let mock: ConnectMock;
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // realpath: on macOS tmpdir() is a symlink and enrollment stores the
    // canonical physical path — assert against the same spelling policy does.
    tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-onb-connect-')));
    savedEnv = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      ASHLR_HOME: process.env['ASHLR_HOME'],
    };
    process.env['HOME'] = tmpHome;
    process.env['USERPROFILE'] = tmpHome;
    process.env['ASHLR_HOME'] = join(tmpHome, '.ashlr');
    codeRoot = join(tmpHome, 'code');
    mkdirSync(codeRoot, { recursive: true });
    repoDir = makeRepo(codeRoot, 'demo');
    mock = await startConnectMock();
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((r) => mock.server.close(() => r()));
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // Fresh module graph per step so config.ts's module-load HOME constants bind
  // to this suite's tmp home (same contract as onboard-index-step.test.ts).
  beforeEach(() => {
    vi.resetModules();
  });

  async function makeCfg(): Promise<AshlrConfig> {
    const { defaultConfig } = await import('../src/core/config.js');
    return {
      ...defaultConfig(),
      roots: [codeRoot],
      daemon: { dailyBudgetUsd: 1, perTickItems: 3, parallel: 2, intervalMs: 100 },
      foundry: { scanTodos: true },
    } as AshlrConfig;
  }

  /** Capture one JSON document written to process.stdout while `run` executes. */
  async function captureStdoutJson<T>(run: () => Promise<T>): Promise<{ code: T; payload: Record<string, unknown> }> {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    try {
      const code = await run();
      return { code, payload: JSON.parse(writes.join('')) as Record<string, unknown> };
    } finally {
      spy.mockRestore();
    }
  }

  it('ONB-1 connect — GET /connect serves the onboarding manifest; unknown routes 404', async () => {
    const res = await fetch(`${mock.origin}/connect`);
    expect(res.status).toBe(200);
    const manifest = expectManifest(await res.json());
    expect(manifest.steps.map((s) => s.id)).toEqual(ONB_STEPS.map((s) => s.id));
    expect(manifest.install).toContain('@ashlr/phantom');

    expect((await fetch(`${mock.origin}/`)).status).toBe(200);
    expect((await fetch(`${mock.origin}/no-such-route`)).status).toBe(404);
    expect(mock.hits).toEqual(['GET /connect', 'GET /', 'GET /no-such-route']);
  });

  it('ONB-2 version — the installed CLI answers `phm --version`', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as { name: string; version: string };
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve('src/cli/index.ts'), '--version'],
      {
        cwd: resolve('.'),
        env: {
          ...process.env,
          HOME: tmpHome,
          USERPROFILE: tmpHome,
          ASHLR_HOME: join(tmpHome, '.ashlr'),
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
    expect(pkg.name).toBe('@ashlr/phantom');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  }, 45_000);

  it('ONB-3 bootstrap — first-run setup creates config and builds the repo index', async () => {
    const { onboard } = await import('../src/core/onboard.js');
    const { INDEX_PATH } = await import('../src/core/config.js');

    const result = await onboard(await makeCfg(), { wire: false, yes: true });

    expect(INDEX_PATH.startsWith(tmpHome)).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.steps.find((s) => s.name === 'config')?.status).toBe('ok');
    const index = result.steps.find((s) => s.name === 'index');
    expect(index?.status).toBe('ok');
    expect(index?.detail).toContain('Indexed 1 repo');
    expect(existsSync(join(tmpHome, '.ashlr', 'config.json'))).toBe(true);
    expect(existsSync(INDEX_PATH)).toBe(true);
  }, 30_000);

  it('ONB-4 preflight — readiness is green and `phm onboard --json` guides without enrolling', async () => {
    const cfg = await makeCfg();
    const { buildReadiness } = await import('../src/core/readiness.js');
    const report = await buildReadiness(cfg);
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);

    const { cmdOnboard } = await import('../src/cli/onboard.js');
    const { _firmOfferInternals } = await import('../src/cli/locus-firm-offer.js');
    _firmOfferInternals.locusAvailable = () => false;
    const { code, payload } = await captureStdoutJson(() => cmdOnboard(['--json', repoDir]));
    expect(code).toBe(0);
    expect(payload['mode']).toBe('steps');
    expect(payload['enrolled']).toBe(false);
    expect(payload['steps']).toHaveLength(5);

    const { listEnrolled } = await import('../src/core/sandbox/policy.js');
    expect(listEnrolled()).toEqual([]);
  }, 30_000);

  it('ONB-5 enroll — the explicit human gate enrolls exactly ONE repo', async () => {
    const { enroll, isEnrolled, listEnrolled } = await import('../src/core/sandbox/policy.js');
    const result = enroll(repoDir);
    expect(result.ok).toBe(true);
    expect(result.quiesced).toBe(true);
    expect(isEnrolled(repoDir)).toBe(true);
    expect(listEnrolled()).toEqual([repoDir]);
  });

  it('ONB-6 dry-run — the plan preview lists work, creates no proposal and spends $0', async () => {
    const cfg = await makeCfg();
    // The daemon's buildBacklog reads scanner flags from the ON-DISK config
    // (~/.ashlr/config.json), not the in-memory cfg. A user opting in to TODO
    // discovery saves it — do the same through the repo's own config API.
    const { loadConfig, saveConfig } = await import('../src/core/config.js');
    const cur = loadConfig();
    saveConfig({ ...cur, foundry: { ...cur.foundry, scanTodos: true } });
    const { renderDryRunPlan } = await import('../src/cli/onboard.js');
    const plan = await renderDryRunPlan(cfg);
    expect(plan).toMatch(/Dry-run plan/i);
    if (todoScannerAvailable()) {
      // The dry-run rebuilds backlog.json from the LIVE scanners, so the plan
      // must surface the seeded marker: title carries the file path, detail
      // carries the TODO text.
      expect(plan).toContain('src/todo-note.ts');
      expect(plan).toContain('onb-e2e-marker');
    } else {
      expect(plan).toMatch(/\d+ item\(s\) would run/);
    }

    const { tick } = await import('../src/core/daemon/loop.js');
    const t = await tick(cfg, { dryRun: true });
    expect(t.proposalsCreated).toBe(0);
    expect(t.spentUsd).toBe(0);

    const { listProposals } = await import('../src/core/inbox/store.js');
    pendingBefore = listProposals({ status: 'pending' }).length;
  }, 30_000);

  it('ONB-7 review — the inbox lists what would run; nothing was auto-applied', async () => {
    const { listProposals } = await import('../src/core/inbox/store.js');
    // The walk so far enrolled + dry-ran: a human review gate lists zero
    // proposals (the plan was a preview) and — the invariant — applied none.
    expect(pendingBefore).toBe(0);
    expect(listProposals({ status: 'pending' })).toEqual([]);
    expect(listProposals({ status: 'applied' })).toEqual([]);
  });

  it('ONB-8 stops — the global kill switch engages and releases', async () => {
    const { setKill, killSwitchOn } = await import('../src/core/sandbox/policy.js');
    const on = setKill(true);
    expect(on.ok).toBe(true);
    expect(killSwitchOn()).toBe(true);
    expect(existsSync(join(tmpHome, '.ashlr', 'KILL'))).toBe(true);
    const off = setKill(false);
    expect(off.ok).toBe(true);
    expect(killSwitchOn()).toBe(false);
  });

  it('ONB-9 rollback — one-command undo unenrolls and sweeps, leaving the tree untouched', async () => {
    const treeBefore = shasumTree(repoDir);
    const { rollback } = await import('../src/cli/onboard.js');
    const { code, payload } = await captureStdoutJson(() =>
      rollback(repoDir, { kill: false, json: true }),
    );
    expect(code).toBe(0);
    expect(payload['ok']).toBe(true);
    expect(payload['mode']).toBe('rollback');
    expect(payload['unenrolled']).toBe(true);

    const { listEnrolled, isEnrolled } = await import('../src/core/sandbox/policy.js');
    expect(listEnrolled()).toEqual([]);
    expect(isEnrolled(repoDir)).toBe(false);
    expect(shasumTree(repoDir)).toBe(treeBefore);
  });
});
