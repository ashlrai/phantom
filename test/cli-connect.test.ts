/**
 * `phm connect`: the one-approval-per-account sign-in wizard.
 *
 * The contract under test:
 *   - `connect request` only ever creates a PENDING record; there is no flag
 *     that approves, and nothing transfers while a request is pending.
 *   - `connect approve` shows a card (account, node, scopes) and transfers
 *     only after an explicit interactive yes, in strict order:
 *     device-login -> scoped-token (vaulted) -> sealed session copy.
 *   - `connect deny` and `connect revoke` write value-free audit entries.
 *   - Secret material never reaches stdout, stderr, the store or the audit
 *     log (asserted against realistic fake tokens and session bytes).
 *   - The CMP Codex session (~/.codex) is excluded from copy, move and
 *     rotation: at the service level and at the path level.
 *   - Discovery runs status commands only (argv assertions).
 *   - Every `--help` path is side-effect free.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runConnectCli, type ConnectCliDeps } from '../src/cli/connect.js';
import {
  CONNECT_SERVICES,
  isExcludedSessionPath,
  sessionCopyRefusal,
} from '../src/core/connect/services.js';
import {
  connectSecretName,
  executeConnectTransfer,
  listSessionFiles,
} from '../src/core/connect/transfer.js';
import { connectStorePath, loadConnectStore } from '../src/core/connect/store.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import type { ConnectDeps, ConnectProbeResult } from '../src/core/connect/types.js';

const FAKE_TOKEN = 'gho_C0NN3CTt3stT0k3n_d0N0tL34k_9f8e7d6c5b';
const FAKE_SESSION = 'SESSION-BYTES-4db1a2c3-secret-should-never-print';

// Every test gets a fresh HOME + ASHLR_HOME so the connect store, audit log
// and fake session files never bleed between cases (the suite-wide setup
// still keeps them out of the real home).
let savedHome: string | undefined;
let savedAshlr: string | undefined;
beforeEach(() => {
  savedHome = process.env['HOME'];
  savedAshlr = process.env['ASHLR_HOME'];
  const home = mkdtempSync(join(tmpdir(), 'phm-connect-'));
  process.env['HOME'] = home;
  process.env['ASHLR_HOME'] = join(home, '.ashlr');
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedAshlr === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlr;
});

interface HarnessOpts {
  /** Status-command results per service id; unset = command fails (signed out). */
  probes?: Record<string, ConnectProbeResult>;
  /** Mint-token stdout per service id (gh, gcloud). */
  tokens?: Record<string, string>;
  /** Interactive vendor-login exit code per argv string; default fails (1). */
  interactive?: Record<string, number>;
  /** confirm() answer: fixed boolean or a per-question function. */
  confirm?: boolean | ((question: string) => boolean);
  hostname?: string;
  mcpServers?: { name: string; command: string }[];
  /** storeSecret failure reason, when the vault should refuse. */
  storeSecretFails?: string;
}

function harness(opts: HarnessOpts = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const runCalls: string[][] = [];
  const interactiveCalls: string[][] = [];
  const stored: { name: string; value: string }[] = [];
  const removed: string[] = [];
  const questions: string[] = [];
  const hostname = opts.hostname ?? 'testhost';

  const core: ConnectDeps = {
    run(argv) {
      runCalls.push([...argv]);
      const key = argv.join(' ');
      for (const s of CONNECT_SERVICES) {
        if (s.probe && s.probe.argv.join(' ') === key) {
          return opts.probes?.[s.id] ?? { status: 1, stdout: '', stderr: 'not signed in' };
        }
        if (s.tokenMint && s.tokenMint.join(' ') === key) {
          const token = opts.tokens?.[s.id];
          return token !== undefined
            ? { status: 0, stdout: `${token}\n`, stderr: '' }
            : { status: 1, stdout: '', stderr: 'no token for you' };
        }
      }
      return { status: 127, stdout: '', stderr: 'unexpected command' };
    },
    runInteractive(argv) {
      interactiveCalls.push([...argv]);
      return opts.interactive?.[argv.join(' ')] ?? 1;
    },
    storeSecret(name, value) {
      stored.push({ name, value });
      return opts.storeSecretFails ? { ok: false, reason: opts.storeSecretFails } : { ok: true };
    },
    removeSecret(name) {
      removed.push(name);
      return { ok: true };
    },
    mcpServers: () => opts.mcpServers ?? [],
    hostname: () => hostname,
    now: () => new Date('2026-03-01T00:00:00Z'),
  };
  const deps: ConnectCliDeps = {
    core,
    confirm: async (question) => {
      questions.push(question);
      return typeof opts.confirm === 'function' ? opts.confirm(question) : opts.confirm ?? false;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, out, err, runCalls, interactiveCalls, stored, removed, questions, hostname };
}

function ghSignedIn(account = 'masonwyatt'): ConnectProbeResult {
  return { status: 0, stdout: `github.com\n  ✓ Logged in to github.com account ${account}\n`, stderr: '' };
}

function auditActions(): string[] {
  return readAudit().map((e) => e.action);
}

function auditRaw(): string {
  const dir = join(homedir(), '.ashlr', 'audit');
  if (!existsSync(dir)) return '';
  return readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
}

// ---------------------------------------------------------------------------
// Discovery: status commands only
// ---------------------------------------------------------------------------

describe('phm connect discover', () => {
  it('runs only catalog status probes and reports signed-in accounts', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, mcpServers: [{ name: 'phantom-secrets', command: 'phantom' }] });
    expect(await runConnectCli(['discover'], h.deps)).toBe(0);
    const expected = CONNECT_SERVICES.filter((s) => s.probe !== null).map((s) => s.probe!.argv);
    for (const argv of expected) {
      expect(h.runCalls.map((c) => c.join(' '))).toContain(argv.join(' '));
    }
    // Nothing beyond probe argv runs during discovery.
    const probeSet = new Set(expected.map((a) => a.join(' ')));
    for (const call of h.runCalls) expect(probeSet.has(call.join(' '))).toBe(true);
    expect(h.out.join('\n')).toContain('masonwyatt');
    expect(h.out.join('\n')).toContain('status commands only');
  });

  it('--json emits value-free discovery rows', async () => {
    const h = harness({ probes: { gh: ghSignedIn() } });
    expect(await runConnectCli(['discover', '--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as { services: { service: string; signedIn: boolean; account: string | null }[] };
    const gh = parsed.services.find((r) => r.service === 'gh');
    expect(gh?.signedIn).toBe(true);
    expect(gh?.account).toBe('masonwyatt');
  });
});

// ---------------------------------------------------------------------------
// Requests stay pending; no flag skips approval
// ---------------------------------------------------------------------------

describe('phm connect request', () => {
  it('creates a pending request and nothing else: no transfer, no grant', async () => {
    const h = harness();
    expect(await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps)).toBe(0);
    const store = loadConnectStore();
    expect(store.requests).toHaveLength(1);
    const req = store.requests[0]!;
    expect(req.status).toBe('pending');
    expect(req.service).toBe('gh');
    expect(req.node).toBe('worker-2');
    expect(req.scopes).toEqual(['repo', 'read:org', 'workflow']);
    expect(store.grants).toHaveLength(0);
    // No subprocess and no secret operation happened for the request itself.
    expect(h.runCalls).toHaveLength(0);
    expect(h.interactiveCalls).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    expect(h.out.join('\n')).toContain('stays pending');
    expect(auditActions()).toContain('connect.request');
  });

  it('has no approval-bypass flag: --yes / --force / --auto are usage errors', async () => {
    for (const flag of ['--yes', '--force', '--auto-approve', '--approve']) {
      const h = harness();
      expect(await runConnectCli(['request', 'gh', '--node', 'worker-2', flag], h.deps)).toBe(2);
    }
    expect(loadConnectStore().requests).toHaveLength(0);
  });

  it('deduplicates an identical pending request instead of stacking', async () => {
    const h = harness();
    expect(await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps)).toBe(0);
    expect(await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('already pending');
    expect(loadConnectStore().requests).toHaveLength(1);
  });

  it('rejects unknown services, bad node ids and unknown methods', async () => {
    const h = harness();
    expect(await runConnectCli(['request', 'not-a-service', '--node', 'w1'], h.deps)).toBe(2);
    expect(await runConnectCli(['request', 'gh', '--node', 'BAD NODE!!'], h.deps)).toBe(2);
    expect(await runConnectCli(['request', 'gh', '--node', 'w1', '--method', 'teleport'], h.deps)).toBe(2);
    expect(await runConnectCli(['request'], h.deps)).toBe(2);
    expect(loadConnectStore().requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Denial
// ---------------------------------------------------------------------------

describe('phm connect deny', () => {
  it('denies a pending request, transfers nothing, and audits it', async () => {
    const h = harness();
    await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps);
    const req = loadConnectStore().requests[0]!;
    expect(await runConnectCli(['deny', req.id], h.deps)).toBe(0);
    const store = loadConnectStore();
    expect(store.requests[0]!.status).toBe('denied');
    expect(store.grants).toHaveLength(0);
    expect(h.interactiveCalls).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
    expect(h.out.join('\n')).toContain('Nothing was transferred');
    expect(auditActions()).toContain('connect.deny');
  });

  it('refuses to deny an absent or already-resolved request', async () => {
    const h = harness();
    expect(await runConnectCli(['deny', 'con_req_missing'], h.deps)).toBe(1);
    await runConnectCli(['request', 'gh', '--node', 'w1'], h.deps);
    const req = loadConnectStore().requests[0]!;
    await runConnectCli(['deny', req.id], h.deps);
    expect(await runConnectCli(['deny', req.id], h.deps)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Approval: card + explicit confirmation + strict-order transfer
// ---------------------------------------------------------------------------

describe('phm connect approve', () => {
  it('shows the approve card (account, node, scopes) and stays pending on a no', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, confirm: false });
    await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps);
    const req = loadConnectStore().requests[0]!;
    expect(await runConnectCli(['approve', req.id], h.deps)).toBe(1);
    const shown = h.out.join('\n');
    expect(shown).toContain('connect approval');
    expect(shown).toContain('service:  gh');
    expect(shown).toContain('account:  masonwyatt');
    expect(shown).toContain('node:     worker-2');
    expect(shown).toContain('scopes:   repo, read:org, workflow');
    expect(h.err.join('\n')).toContain('stays pending');
    const store = loadConnectStore();
    expect(store.requests[0]!.status).toBe('pending');
    expect(store.grants).toHaveLength(0);
  });

  it('on yes, transfers device-login first: remote node yields the exact operator command', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, confirm: true });
    await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps);
    const req = loadConnectStore().requests[0]!;
    expect(await runConnectCli(['approve', req.id], h.deps)).toBe(0);
    const store = loadConnectStore();
    expect(store.requests[0]!.status).toBe('approved');
    expect(store.grants).toHaveLength(1);
    const grant = store.grants[0]!;
    expect(grant.method).toBe('device-login');
    expect(grant.delivery).toBe('operator-command');
    expect(grant.node).toBe('worker-2');
    expect(store.requests[0]!.grantId).toBe(grant.id);
    // No local interactive run and no token mint for a remote node.
    expect(h.interactiveCalls).toHaveLength(0);
    expect(h.out.join('\n')).toContain('gh auth login --web');
    expect(auditActions()).toContain('connect.grant');
  });

  it('local node falls through device-login -> scoped-token, vaulted by name', async () => {
    const h = harness({
      probes: { gh: ghSignedIn() },
      tokens: { gh: FAKE_TOKEN },
      confirm: true,
    });
    await runConnectCli(['request', 'gh', '--node', 'local'], h.deps);
    const req = loadConnectStore().requests[0]!;
    expect(await runConnectCli(['approve', req.id], h.deps)).toBe(0);
    const grant = loadConnectStore().grants[0]!;
    expect(grant.method).toBe('scoped-token');
    expect(grant.delivery).toBe('vaulted');
    expect(grant.secretName).toBe(connectSecretName('gh', 'testhost'));
    // The vendor login ran interactively first, then the mint, then the vault.
    expect(h.interactiveCalls).toEqual([['gh', 'auth', 'login', '--web']]);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]!.name).toBe('PHM_CONNECT_GH_TESTHOST');
    expect(h.stored[0]!.value).toBe(FAKE_TOKEN);
    // Strict order is recorded on the grant.
    expect(grant.attempts.map((a) => a.method)).toEqual(['device-login', 'scoped-token']);
    expect(grant.attempts[0]!.outcome).toBe('failed');
    expect(grant.attempts[1]!.outcome).toBe('ok');
  });

  it('resolves a pending request by service name when unambiguous', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, confirm: true });
    await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps);
    expect(await runConnectCli(['approve', 'gh'], h.deps)).toBe(0);
    expect(loadConnectStore().grants).toHaveLength(1);
  });

  it('refuses when nothing is pending', async () => {
    const h = harness({ confirm: true });
    expect(await runConnectCli(['approve', 'gh'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('No pending request');
  });
});

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

describe('phm connect revoke', () => {
  async function makeVaultedGrant(h: ReturnType<typeof harness>): Promise<string> {
    await runConnectCli(['request', 'gh', '--node', 'local'], h.deps);
    const req = loadConnectStore().requests[0]!;
    await runConnectCli(['approve', req.id], h.deps);
    return loadConnectStore().grants[0]!.id;
  }

  it('revokes a live grant, removes the vault secret by name, audits it', async () => {
    const h = harness({
      probes: { gh: ghSignedIn() },
      tokens: { gh: FAKE_TOKEN },
      confirm: true,
    });
    const grantId = await makeVaultedGrant(h);
    expect(await runConnectCli(['revoke', grantId], h.deps)).toBe(0);
    const grant = loadConnectStore().grants[0]!;
    expect(grant.revokedAt).not.toBeNull();
    // The vault secret was removed by name, never by value.
    expect(h.removed).toEqual(['PHM_CONNECT_GH_TESTHOST']);
    expect(auditActions()).toContain('connect.revoke');
    // Status no longer reports it as active.
    h.out.length = 0;
    expect(await runConnectCli(['status', '--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as { active: unknown[]; revoked: { id: string }[] };
    expect(parsed.active).toHaveLength(0);
    expect(parsed.revoked.map((g) => g.id)).toContain(grantId);
  });

  it('keeps the grant live when the operator declines the confirm', async () => {
    const h = harness({
      probes: { gh: ghSignedIn() },
      tokens: { gh: FAKE_TOKEN },
      confirm: (q) => !q.includes('Revoke'),
    });
    const grantId = await makeVaultedGrant(h);
    expect(await runConnectCli(['revoke', grantId], h.deps)).toBe(1);
    expect(loadConnectStore().grants[0]!.revokedAt).toBeNull();
    expect(h.removed).toHaveLength(0);
  });

  it('refuses absent and double revocation', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, tokens: { gh: FAKE_TOKEN }, confirm: true });
    expect(await runConnectCli(['revoke', 'con_gr_missing'], h.deps)).toBe(1);
    const grantId = await makeVaultedGrant(h);
    await runConnectCli(['revoke', grantId], h.deps);
    expect(await runConnectCli(['revoke', grantId], h.deps)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('phm connect status', () => {
  it('shows discovered sign-ins, pending requests with actions, and grants', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, confirm: true });
    await runConnectCli(['request', 'gh', '--node', 'worker-2'], h.deps);
    expect(await runConnectCli(['status'], h.deps)).toBe(0);
    const shown = h.out.join('\n');
    expect(shown).toContain('Discovered on this machine');
    expect(shown).toContain('masonwyatt');
    expect(shown).toContain('Pending requests');
    expect(shown).toContain('approve: phm connect approve');
    expect(shown).toContain('deny: phm connect deny');
  });

  it('--json is machine-readable and carries no secret material', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, tokens: { gh: FAKE_TOKEN }, confirm: true });
    await runConnectCli(['request', 'gh', '--node', 'local'], h.deps);
    const req = loadConnectStore().requests[0]!;
    await runConnectCli(['approve', req.id], h.deps);
    h.out.length = 0;
    expect(await runConnectCli(['status', '--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as {
      active: { service: string; node: string; secretName: string }[];
      discovered: { service: string; signedIn: boolean }[];
    };
    expect(parsed.active[0]!.service).toBe('gh');
    expect(parsed.active[0]!.secretName).toBe('PHM_CONNECT_GH_TESTHOST');
    expect(h.out.join('\n')).not.toContain(FAKE_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

describe('phm connect (wizard)', () => {
  it('walks each signed-in account, one approval each, in strict order', async () => {
    const h = harness({
      probes: { gh: ghSignedIn(), vercel: { status: 0, stdout: 'mason-wyatt\n', stderr: '' } },
      tokens: { gh: FAKE_TOKEN },
      // gh: vendor login fails locally, so it falls through to the vaulted
      // scoped token. vercel: its own device login succeeds directly.
      interactive: { 'vercel login': 0 },
      confirm: true,
    });
    expect(await runConnectCli([], h.deps)).toBe(0);
    const shown = h.out.join('\n');
    expect(shown).toContain('connect approval');
    expect(shown).toContain('account:  masonwyatt');
    const grants = loadConnectStore().grants;
    expect(grants).toHaveLength(2);
    expect(grants.map((g) => g.service).sort()).toEqual(['gh', 'vercel']);
    expect(grants.find((g) => g.service === 'gh')!.method).toBe('scoped-token');
    expect(grants.find((g) => g.service === 'vercel')!.method).toBe('device-login');
  });

  it('connects nothing when every approval is declined', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, confirm: false });
    expect(await runConnectCli([], h.deps)).toBe(0);
    expect(loadConnectStore().grants).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Strict transfer order + last-resort sealed session copy (core engine)
// ---------------------------------------------------------------------------

describe('executeConnectTransfer', () => {
  it('device-login first: a working vendor login never reaches the token mint', async () => {
    const h = harness({
      interactive: { 'gh auth login --web': 0 },
      tokens: { gh: FAKE_TOKEN },
    });
    const result = await executeConnectTransfer(
      { service: 'gh', node: 'testhost', account: 'masonwyatt', scopes: ['repo'] },
      h.deps.core,
    );
    expect(result.ok).toBe(true);
    expect(result.grant!.method).toBe('device-login');
    expect(result.grant!.delivery).toBe('executed');
    // The token mint argv was never attempted.
    expect(h.runCalls.map((c) => c.join(' '))).not.toContain('gh auth token');
    expect(h.stored).toHaveLength(0);
  });

  it('session copy is last resort and needs an explicit approver', async () => {
    // claude: no token-mint path; interactive login fails; a session file exists.
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), FAKE_SESSION, { mode: 0o600 });
    const h = harness();
    const noApprover = await executeConnectTransfer(
      { service: 'claude', node: 'testhost', account: null, scopes: ['anthropic-account'] },
      h.deps.core,
    );
    expect(noApprover.ok).toBe(false);
    const last = noApprover.attempts[noApprover.attempts.length - 1]!;
    expect(last.method).toBe('session-copy');
    expect(last.outcome).toBe('refused');
    expect(last.reason).toContain('explicit approval');
  });

  it('seals approved session files; the bundle key lands in the vault', async () => {
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), FAKE_SESSION, { mode: 0o600 });
    const h = harness();
    const approvedRels: string[] = [];
    const result = await executeConnectTransfer(
      {
        service: 'claude',
        node: 'testhost',
        account: null,
        scopes: ['anthropic-account'],
        confirmSessionFile: async (rel) => { approvedRels.push(rel); return true; },
      },
      h.deps.core,
    );
    expect(result.ok).toBe(true);
    const grant = result.grant!;
    expect(grant.method).toBe('session-copy');
    expect(grant.delivery).toBe('sealed-bundle');
    expect(approvedRels.length).toBeGreaterThan(0);
    expect(grant.sessionPaths).toEqual(approvedRels);
    // Attempt order is the strict ladder.
    expect(grant.attempts.map((a) => a.method)).toEqual(['device-login', 'scoped-token', 'session-copy']);
    // The bundle file exists; its contents are ciphertext, not the session.
    const bundlePath = join(homedir(), '.ashlr', 'connect', 'bundles', grant.bundleFile!);
    expect(existsSync(bundlePath)).toBe(true);
    expect(readFileSync(bundlePath, 'utf8')).not.toContain(FAKE_SESSION);
    // The data key was vaulted, never written next to the bundle.
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]!.name).toMatch(/^PHM_CONNECT_BUNDLE_/);
    expect(h.stored[0]!.value).not.toBe(FAKE_SESSION);
  });
});

// ---------------------------------------------------------------------------
// HARD EXCEPTION: ~/.codex is excluded from copy, move and rotation
// ---------------------------------------------------------------------------

describe('the CMP Codex session exclusion', () => {
  it('excludes ~/.codex and everything under it at the path level', () => {
    expect(isExcludedSessionPath('.codex')).toBe(true);
    expect(isExcludedSessionPath('.codex/auth.json')).toBe(true);
    expect(isExcludedSessionPath('.codex/sessions/2026/rollout.jsonl')).toBe(true);
    expect(isExcludedSessionPath('.config/gh/hosts.yml')).toBe(false);
    expect(isExcludedSessionPath('.codex-sessions/auth.json')).toBe(false);
  });

  it('refuses codex session copy outright, with the CMP Codex reason', () => {
    const reason = sessionCopyRefusal('codex', '.codex/auth.json');
    expect(reason).not.toBeNull();
    expect(reason).toContain('~/.codex');
    expect(reason).toContain('copy, move and rotation');
    // And defensively: a codex path under a DIFFERENT service is refused too.
    const defense = sessionCopyRefusal('gh', '.codex/auth.json');
    expect(defense).not.toBeNull();
    expect(defense).toContain('~/.codex');
    // A benign path is allowed through the gate.
    expect(sessionCopyRefusal('gh', join('.config', 'gh', 'hosts.yml'))).toBeNull();
  });

  it('listSessionFiles never returns codex files even when they exist', () => {
    const codexDir = join(homedir(), '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), FAKE_SESSION, { mode: 0o600 });
    expect(listSessionFiles('codex')).toEqual([]);
  });

  it('the transfer engine refuses session-copy for codex before reading anything', async () => {
    const codexDir = join(homedir(), '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'auth.json'), FAKE_SESSION, { mode: 0o600 });
    const h = harness({ confirm: true });
    const result = await executeConnectTransfer(
      {
        service: 'codex',
        node: 'testhost',
        account: null,
        scopes: ['chatgpt-account'],
        requestedMethod: 'session-copy',
        confirmSessionFile: async () => true,
      },
      h.deps.core,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('~/.codex');
    const attempt = result.attempts[0]!;
    expect(attempt.method).toBe('session-copy');
    expect(attempt.outcome).toBe('refused');
    expect(attempt.reason).toContain('copy, move and rotation');
  });

  it('the codex row announces the exclusion to the operator', async () => {
    const h = harness({
      probes: { codex: { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' } },
    });
    expect(await runConnectCli(['discover', '--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as { services: { service: string; notes: string[] }[] };
    const codex = parsed.services.find((r) => r.service === 'codex')!;
    expect(codex.notes.join(' ')).toContain('~/.codex');
  });
});

// ---------------------------------------------------------------------------
// No-print: nothing secret-shaped reaches stdout, stderr, store or audit
// ---------------------------------------------------------------------------

describe('no secret-shaped output', () => {
  it('a vaulted grant never prints or persists the token value', async () => {
    const h = harness({ probes: { gh: ghSignedIn() }, tokens: { gh: FAKE_TOKEN }, confirm: true });
    await runConnectCli(['request', 'gh', '--node', 'local'], h.deps);
    const req = loadConnectStore().requests[0]!;
    await runConnectCli(['approve', req.id], h.deps);
    h.out.length = 0;
    await runConnectCli(['status'], h.deps);
    await runConnectCli(['status', '--json'], h.deps);
    await runConnectCli(['requests'], h.deps);
    const surfaces = [...h.out, ...h.err].join('\n');
    expect(surfaces).not.toContain(FAKE_TOKEN);
    expect(readFileSync(connectStorePath(), 'utf8')).not.toContain(FAKE_TOKEN);
    expect(auditRaw()).not.toContain(FAKE_TOKEN);
    expect(auditRaw()).toContain('connect.grant');
  });

  it('a sealed session copy never leaks session bytes to any surface', async () => {
    const claudeDir = join(homedir(), '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, '.credentials.json'), FAKE_SESSION, { mode: 0o600 });
    const h = harness({ probes: { claude: { status: 0, stdout: '{"loggedIn":true,"email":"m@x.io"}', stderr: '' } }, confirm: true });
    await runConnectCli(['request', 'claude', '--node', 'local'], h.deps);
    const req = loadConnectStore().requests[0]!;
    expect(await runConnectCli(['approve', req.id], h.deps)).toBe(0);
    const surfaces = [...h.out, ...h.err, ...h.questions].join('\n');
    expect(surfaces).not.toContain(FAKE_SESSION);
    expect(readFileSync(connectStorePath(), 'utf8')).not.toContain(FAKE_SESSION);
    expect(auditRaw()).not.toContain(FAKE_SESSION);
    // The grant exists and is sealed-bundle delivered.
    const grant = loadConnectStore().grants[0]!;
    expect(grant.delivery).toBe('sealed-bundle');
  });
});

// ---------------------------------------------------------------------------
// Help is side-effect free; unknown verbs refuse
// ---------------------------------------------------------------------------

describe('help and parsing', () => {
  it('every help path exits 0 and writes nothing to the store', async () => {
    const h = harness();
    for (const args of [
      ['--help'], ['-h'], ['help'],
      ['status', '--help'], ['request', '--node', 'w1', '--help'],
      ['approve', '--help'], ['revoke', '-h'], ['wizard', '--help'],
    ]) {
      expect(await runConnectCli(args, { out: h.deps.out, err: h.deps.err })).toBe(0);
    }
    expect(h.out.join('\n')).toContain('phm connect');
    expect(existsSync(connectStorePath())).toBe(false);
  });

  it('unknown verbs and stray flags are usage errors', async () => {
    const h = harness();
    expect(await runConnectCli(['frobnicate'], h.deps)).toBe(2);
    expect(await runConnectCli(['status', '--bogus'], h.deps)).toBe(2);
    expect(await runConnectCli(['discover', 'extra'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toContain('--bogus');
  });
});
