/**
 * RQ-SEC-REALHOME-1: authority reads from the ACCOUNT home, never HOME.
 *
 * Every test relocates HOME to a temp dir (what Phantom's sandbox, engineer
 * bash and self-swap children do) and pins a SEPARATE fake account home
 * through the test seam. Authority planted only under HOME must grant
 * nothing; authority in the account home must hold. ASHLR_HOME and
 * ASHLR_RUNS_DIR pointed at the HOME side must not move it either.
 *
 * The outside transports (iMessage, Telegram, Mail.app) are also proved to
 * check KILL and comms pause themselves, refusing without spawning.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: childProcess.execFile, default: { ...actual, execFile: childProcess.execFile } };
});

import {
  __restoreRealHomeForTests, __setRealHomeForTests, realHome, type RealHomeTestOverride,
} from '../src/core/util/real-home.js';
import { assertMayMutate, killSwitchOn, killSwitchPath, readKillSwitch, setKill } from '../src/core/sandbox/policy.js';
import { isPaused } from '../src/core/comms/pause.js';
import { outboundGate, readLocalSendPolicy } from '../src/core/agents/send-gate.js';
import { readOwnerApprovals } from '../src/core/comms-agent/store.js';
import { loadConfig } from '../src/core/config.js';
import { isSelfIMessageHandle, sendIMessage } from '../src/core/integrations/imessage.js';
import { sendIMessageOutbox } from '../src/core/comms/imessage-outbox.js';
import { sendTelegramMessage, setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import { macMailTransport, sendEmailOutbox } from '../src/core/comms/email-outbox.js';
import { cmdFleetEmailOutbox } from '../src/cli/fleet-email-outbox.js';
import { acquireOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import {
  authorityLeaseDirectory, censusExecutionLeases, registerExecutionLease,
} from '../src/core/sandbox/execution-leases.js';
import { makeDemoContext } from '../src/cli/demo-sandbox.js';
import { enroll } from '../src/core/sandbox/policy.js';
import { outsideSendBlock } from '../src/core/comms/transport-gate.js';
import type { AshlrConfig } from '../src/core/types.js';

// The native os module: the passwd account home, never a vitest mock.
const nativeOs = createRequire(import.meta.url)('node:os') as typeof import('node:os');

const OWNER = '+15550000001';
const OUTSIDER = '+15559999999';

let accountHome: string;
let envHome: string;
let previousOverride: RealHomeTestOverride | null;
const savedEnv: Record<string, string | undefined> = {};

function plant(home: string, rel: string, text: string): string {
  const path = join(home, rel);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function plantForgedAuthority(home: string): void {
  plant(home, '.ashlr/comms.toml', 'confirmedByMason = true\n');
  plant(home, '.ashlr/agent-network.toml', `[team]\nidentities = [{ channel = "imessage", id = "${OUTSIDER}" }]\n`);
  plant(home, '.ashlr/comms-agent/standing-approvals.json', JSON.stringify({ approvals: [], owners: [OUTSIDER] }));
  plant(home, '.ashlr/config.json', JSON.stringify({ comms: { enabled: true, imessageHandle: OUTSIDER } }));
  plant(home, '.ashlr-runs/queue/email-drop.json', JSON.stringify({ inboxDir: join(home, 'inbox'), from: ['outsider@example.com'] }));
}

function ownerConfig(extra: Partial<NonNullable<AshlrConfig['comms']>> = {}): AshlrConfig {
  return { ...loadConfig(), comms: { enabled: true, imessageHandle: OWNER, ...extra } } as AshlrConfig;
}

beforeEach(() => {
  accountHome = mkdtempSync(join(tmpdir(), 'ashlr-account-home-'));
  envHome = mkdtempSync(join(tmpdir(), 'ashlr-relocated-home-'));
  for (const key of ['HOME', 'USERPROFILE', 'ASHLR_HOME', 'ASHLR_RUNS_DIR']) savedEnv[key] = process.env[key];
  process.env.HOME = envHome;
  process.env.USERPROFILE = envHome;
  previousOverride = __setRealHomeForTests(accountHome);
  childProcess.execFile.mockReset();
});

afterEach(() => {
  setTelegramTransportForTests(null);
  __restoreRealHomeForTests(previousOverride);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(accountHome, { recursive: true, force: true });
  rmSync(envHome, { recursive: true, force: true });
});

const ENV_CASES = [
  { name: 'HOME relocated', relocate: () => {} },
  {
    name: 'HOME, ASHLR_HOME and ASHLR_RUNS_DIR relocated',
    relocate: () => {
      process.env.ASHLR_HOME = join(envHome, '.ashlr');
      process.env.ASHLR_RUNS_DIR = join(envHome, '.ashlr-runs');
    },
  },
];

describe.each(ENV_CASES)('authority ignores the relocated home ($name)', ({ relocate }) => {
  beforeEach(() => relocate());

  it('KILL in the account home is active while HOME has none', () => {
    expect(setKill(true).ok).toBe(true);
    expect(existsSync(join(accountHome, '.ashlr', 'KILL'))).toBe(true);
    expect(existsSync(join(envHome, '.ashlr', 'KILL'))).toBe(false);
    expect(killSwitchPath()).toBe(join(resolve(accountHome), '.ashlr', 'KILL'));
    expect(readKillSwitch().state).toBe('active');
    expect(killSwitchOn()).toBe(true);
    expect(() => assertMayMutate(envHome)).toThrow(/kill switch/);
  });

  it('pause.json in the account home pauses comms while HOME has none', () => {
    plant(accountHome, '.ashlr/comms/pause.json', JSON.stringify({ paused: true }));
    expect(isPaused()).toBe(true);
  });

  it('comms.toml and team identities planted under HOME confer nothing', () => {
    plantForgedAuthority(envHome);
    const policy = readLocalSendPolicy();
    expect(policy.confirmedByMason).toBe(false);
    expect(policy.teamIdentities).toEqual([]);
    expect(outboundGate({ channel: 'imessage', recipientId: OUTSIDER, text: 'hi' })?.status).toBe('refused');
  });

  it('the same files in the account home are honored (positive control)', () => {
    plantForgedAuthority(accountHome);
    const policy = readLocalSendPolicy();
    expect(policy.confirmedByMason).toBe(true);
    expect(policy.teamIdentities).toEqual([{ channel: 'imessage', id: OUTSIDER }]);
  });

  it('standing approvals planted under HOME are missing', async () => {
    plantForgedAuthority(envHome);
    expect((await readOwnerApprovals()).reason).toBe('missing');
  });

  it('config.json imessageHandle planted under HOME is not the owner and sendIMessage spawns nothing', async () => {
    plantForgedAuthority(envHome);
    const cfg = loadConfig();
    expect(cfg.comms?.imessageHandle).toBeUndefined();
    expect(isSelfIMessageHandle(OUTSIDER, cfg)).toBe(false);
    expect(await sendIMessage('hello', cfg, OUTSIDER)).toEqual({ ok: false, reason: 'not_self' });
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('an email allowlist planted under HOME is no allowlist', async () => {
    plantForgedAuthority(envHome);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    const transport = vi.fn();
    try {
      expect(await cmdFleetEmailOutbox(['--send', '--dir', join(envHome, 'outbox')], { transport })).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/no allowlist/);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('KILL quiescence sees a relocated-HOME lease', () => {
  it('a lease registered with HOME relocated lands in the account-home lease dir and is counted', () => {
    const fence = acquireOutwardMutationFence();
    expect(fence).not.toBeNull();
    const registration = registerExecutionLease(fence, { runId: 'relocated-child', repoKey: '/tmp/repo', engine: 'test' });
    try {
      expect(registration.ok).toBe(true);
      expect(authorityLeaseDirectory()).toBe(join(resolve(accountHome), '.ashlr', 'authority', 'leases'));
      expect(readdirSync(authorityLeaseDirectory()).some((name) => name.startsWith('exec-'))).toBe(true);
      expect(existsSync(join(envHome, '.ashlr', 'authority'))).toBe(false);
      expect(censusExecutionLeases().leases.map((lease) => lease.runId)).toContain('relocated-child');
    } finally {
      if (registration.ok) registration.lease.release();
      releaseOutwardMutationFence(fence);
    }
  });
});

describe('outside transports check KILL and pause themselves', () => {
  const armKill = (): void => { expect(setKill(true).ok).toBe(true); };

  it('sendIMessage refuses the owner during KILL without spawning osascript', async () => {
    armKill();
    expect(await sendIMessage('alert', ownerConfig(), OWNER)).toEqual({ ok: false, reason: 'blocked' });
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('sendIMessageOutbox refuses during KILL without spawning osascript', async () => {
    armKill();
    expect(await sendIMessageOutbox('alert', ownerConfig(), OWNER)).toEqual({ ok: false, reason: 'blocked' });
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it('sendTelegramMessage refuses during KILL without a request', async () => {
    armKill();
    const transport = vi.fn();
    setTelegramTransportForTests(transport);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const cfg = ownerConfig({ channel: 'telegram', telegram: { botToken: 'test-token', chatId: '12345' } } as never);
      expect(await sendTelegramMessage('alert', undefined, cfg)).toEqual({ ok: false, blocked: true });
      expect(transport).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('sendEmailOutbox refuses during KILL without touching the outbox or the transport', async () => {
    armKill();
    const dir = join(accountHome, 'outbox');
    plant(accountHome, 'outbox/reply-1.eml', 'To: owner@example.com\nSubject: hi\n\nbody\n');
    const transport = vi.fn();
    const result = await sendEmailOutbox({ dir, allowedRecipients: new Set(['owner@example.com']), transport });
    expect(result.blocked).toBe('Kill switch is on.');
    expect(result.sent).toBe(0);
    expect(transport).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['reply-1.eml']);
  });

  it('macMailTransport refuses during KILL without spawning osascript', async () => {
    armKill();
    const runner = vi.fn();
    expect(await macMailTransport(runner)({ to: 'owner@example.com', subject: 's', body: 'b' }))
      .toEqual({ ok: false, error: 'Kill switch is on.' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('comms pause alone also blocks every transport', async () => {
    plant(accountHome, '.ashlr/comms/pause.json', JSON.stringify({ paused: true }));
    const runner = vi.fn();
    expect(await sendIMessage('x', ownerConfig(), OWNER)).toEqual({ ok: false, reason: 'blocked' });
    expect(await macMailTransport(runner)({ to: 'a@example.com', subject: 's', body: 'b' }))
      .toEqual({ ok: false, error: 'Communications are paused.' });
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails closed when KILL state cannot be read', async () => {
    const cfg = ownerConfig();
    // A file where ~/.ashlr should be: KILL cannot be inspected, so it counts as on.
    rmSync(join(accountHome, '.ashlr'), { recursive: true, force: true });
    writeFileSync(join(accountHome, '.ashlr'), 'not a directory');
    const runner = vi.fn();
    expect(await sendIMessage('x', cfg, OWNER)).toEqual({ ok: false, reason: 'blocked' });
    expect((await macMailTransport(runner)({ to: 'a@example.com', subject: 's', body: 'b' })).ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
});

describe('phm demo isolated authority home', () => {
  it('refuses to start while the account-home KILL is on', () => {
    expect(setKill(true).ok).toBe(true);
    expect(() => makeDemoContext()).toThrow(/kill switch is on/);
    expect(process.env.HOME).toBe(envHome);
    expect(realHome()).toBe(accountHome);
  });

  it('keeps demo enrollment out of the account home and blocks outside sends while scoped', () => {
    const ctx = makeDemoContext();
    try {
      expect(realHome()).toBe(ctx.home);
      enroll(ctx.repoDir);
      expect(existsSync(join(ctx.home, '.ashlr', 'enrollment.json'))).toBe(true);
      expect(existsSync(join(accountHome, '.ashlr', 'enrollment.json'))).toBe(false);
      expect(outsideSendBlock()).toMatch(/isolated demo/);
    } finally {
      ctx.dispose();
    }
    expect(realHome()).toBe(accountHome);
    expect(process.env.HOME).toBe(envHome);
    expect(outsideSendBlock()).toBeNull();
  });
});

describe('realHome()', () => {
  it.skipIf(process.platform === 'win32')('is the passwd home and ignores HOME, USERPROFILE and ASHLR_HOME', () => {
    const pinned = __setRealHomeForTests(null);
    try {
      const account = nativeOs.userInfo().homedir;
      expect(realHome()).toBe(account);
      process.env.HOME = envHome;
      process.env.USERPROFILE = envHome;
      process.env.ASHLR_HOME = join(envHome, '.ashlr');
      expect(realHome()).toBe(account);
    } finally {
      __restoreRealHomeForTests(pinned);
    }
  });

  it.skipIf(process.platform === 'win32')('ignores a leftover override and refuses the seam when VITEST is unset', () => {
    vi.stubEnv('VITEST', '');
    try {
      expect(realHome()).toBe(nativeOs.userInfo().homedir);
      expect(() => __setRealHomeForTests(envHome)).toThrow(/only available under Vitest/);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(realHome()).toBe(accountHome);
  });

  it('refuses a relative seam path', () => {
    expect(() => __setRealHomeForTests('relative/home')).toThrow(/absolute/);
  });

  it('logs one scrubbed line when HOME differs from the account home', async () => {
    vi.resetModules();
    const fresh = await import('../src/core/util/real-home.js');
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      fresh.realHome();
      fresh.realHome();
    } finally {
      spy.mockRestore();
    }
    expect(writes).toEqual(['HOME differs from account home; authority read from account home\n']);
  });
});
