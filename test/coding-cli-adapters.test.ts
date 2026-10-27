/**
 * Coding CLI adapters: catalog, env scrub, role refusal, fixture probes,
 * dry-run plans. Fake binaries and injected runners only. No network.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdWorker } from '../src/cli/worker.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';
import { adapterById, grokBillingFromStatus, grokOutputIsMetered, interpretModelProbe } from '../src/core/providers/coding-cli/adapters.js';
import { loadCatalog, selectLocalCandidate, usableModelName, type CodingCliCatalog } from '../src/core/providers/coding-cli/catalog.js';
import { omlxModelsUrl, probeOmlx } from '../src/core/providers/coding-cli/omlx.js';
import { isSecretEnvName, scrubAdapterEnv } from '../src/core/providers/coding-cli/env.js';
import { cooldownActive, parseCliCooldown } from '../src/core/providers/coding-cli/limits.js';
import { probeAvailability, probeModel, type CliRunner } from '../src/core/providers/coding-cli/probe.js';
import { spawnCli } from '../src/core/providers/coding-cli/spawn.js';
import { executeStep, formatPlan, parseIssues, planWorker } from '../src/core/providers/coding-cli/worker-plan.js';
import { billingBlocksCredential, roleAllowed } from '../src/core/routing/backend-roles.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/coding-cli/cli-output.txt'), 'utf8');
const line = (prefix: string): string => {
  const found = FIXTURE.split('\n').find((row) => row.startsWith(prefix));
  if (!found) throw new Error(`missing fixture ${prefix}`);
  return found.slice(prefix.length).trim();
};

const NOW = Date.parse('2026-10-26T02:00:00.000Z');

function runner(script: (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => { code: number; stdout: string; stderr: string }): CliRunner {
  return { run: async (bin, args, env) => script(bin, args, env) };
}

describe('coding CLI catalog from the Mac inventory', () => {
  const catalog = loadCatalog();

  it('keeps rejected account names off the model flag', () => {
    expect(catalog.cacheListings.codex).toContain('gpt-6.1-sol');
    expect(catalog.cacheListings.rejectedOnAccount).toEqual(['gpt-6.1-sol', 'gpt-5.5']);
    const sol = catalog.tiers.workhorse.find((row) => row.candidate === 'gpt-6.1-sol');
    expect(sol?.accountStatus).toBe('rejected');
    expect(usableModelName(sol)).toBeNull();
    expect(catalog.tiers.frontier.every((row) => usableModelName(row) === null)).toBe(true);
  });

  it('classifies grok as metered and off by default', () => {
    expect(catalog.backends.grok?.billing).toBe('metered');
    expect(catalog.backends.grok?.enabledByDefault).toBe(false);
    expect(catalog.meteredEnabledByDefault).toBe(false);
    expect(catalog.backends.codex?.billing).toBe('subscription');
    expect(catalog.backends.ollama?.billing).toBe('local');
    expect(catalog.backends.ollama?.fallbackFor).toBe('omlx');
    expect(catalog.backends.omlx?.billing).toBe('loopback');
    expect(omlxModelsUrl(catalog.backends.omlx?.baseUrl ?? '')).toBe('http://127.0.0.1:8000/v1/models');
  });

  it('picks the largest installed local generator that fits RAM', () => {
    const chosen = selectLocalCandidate(catalog, 128);
    expect(chosen?.backend).toBe('ollama');
    expect(chosen?.candidate).toBe('qwen3.8:27b-ctx64k');
    expect(selectLocalCandidate(catalog, 30)?.candidate).toBe('gpt-oss:20b');
    expect(catalog.backends.lmstudio?.installed).toBe(false);
    expect(catalog.backends.mlx?.installed).toBe(false);
  });

  it('prefers a fitting oMLX model and falls back to Ollama', () => {
    const omlxRow = { intent: 'local omlx', backend: 'omlx', candidate: 'local-small', accountStatus: 'listed' as const, sizeGb: 2, task: 'generate' as const };
    const withOmlx: CodingCliCatalog = {
      ...catalog,
      tiers: { ...catalog.tiers, local: [omlxRow, ...catalog.tiers.local] },
    };
    expect(selectLocalCandidate(withOmlx, 128)?.backend).toBe('omlx');
    expect(selectLocalCandidate(withOmlx, 128)?.candidate).toBe('local-small');
    const remote: CodingCliCatalog = {
      ...withOmlx,
      backends: {
        ...withOmlx.backends,
        omlx: { billing: 'loopback', bin: null, enabledByDefault: true, baseUrl: 'http://10.1.2.3:8000/v1' },
      },
    };
    expect(selectLocalCandidate(remote, 128)?.backend).toBe('ollama');
    const tooBig: CodingCliCatalog = {
      ...catalog,
      tiers: {
        ...catalog.tiers,
        local: [{ ...omlxRow, sizeGb: 100 }, ...catalog.tiers.local],
      },
    };
    expect(selectLocalCandidate(tooBig, 30)?.candidate).toBe('gpt-oss:20b');
  });
});

describe('oMLX loopback', () => {
  it('lists models on loopback and does not request a remote host', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const listed = await probeOmlx('http://127.0.0.1:8000/v1', async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { status: 200, text: async () => JSON.stringify({ data: [{ id: 'local-small' }] }) };
    });
    expect(listed).toEqual({ ok: true, models: ['local-small'] });
    expect(seen.map((call) => call.url)).toEqual(['http://127.0.0.1:8000/v1/models']);
    expect(JSON.stringify(seen[0]?.headers).toLowerCase()).not.toContain('authorization');
    let called = false;
    const refused = await probeOmlx('http://10.1.2.3:8000/v1', async () => {
      called = true;
      return { status: 200, text: async () => '{}' };
    });
    expect(called).toBe(false);
    expect(refused).toEqual({ ok: false, reason: 'remote-not-allowed' });
    expect(omlxModelsUrl('http://example.com/v1')).toBeNull();
  });
});

describe('grok billing', () => {
  it('prefers a subscription login over the metered API key line', () => {
    expect(grokBillingFromStatus(line('grok models:'))).toBe('metered');
    expect(grokOutputIsMetered(line('grok models:'))).toBe(true);
    expect(grokBillingFromStatus(line('grok subscription:'))).toBe('subscription');
    expect(grokBillingFromStatus(line('grok both:'))).toBe('subscription');
  });
});

describe('adapter env scrub', () => {
  it('drops Phantom-managed tokens and keeps the CLI home', () => {
    const env = scrubAdapterEnv({
      PATH: '/usr/bin',
      HOME: '/Users/mason',
      CODEX_HOME: '/Users/mason/.codex',
      GH_TOKEN: 'ghp_secret',
      GITHUB_TOKEN: 'ghp_other',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-openai',
      XAI_API_KEY: 'xai-secret',
      DEVIN_API_KEY: 'devin-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
      SSH_AUTH_SOCK: '/tmp/sock',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/mason');
    expect(env.CODEX_HOME).toBe('/Users/mason/.codex');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    for (const key of Object.keys(env)) expect(isSecretEnvName(key)).toBe(false);
    expect(JSON.stringify(env)).not.toMatch(/ghp_|sk-ant|sk-openai|xai-secret|devin-secret|oauth-secret/);
  });
});

describe('privileged roles', () => {
  it('refuses merge and credential for subscription, local, loopback and metered backends', () => {
    for (const billing of ['subscription', 'local', 'loopback', 'metered'] as const) {
      expect(roleAllowed(billing, 'merge')).toBe(false);
      expect(roleAllowed(billing, 'credential')).toBe(false);
      expect(roleAllowed(billing, 'produce')).toBe(true);
      expect(roleAllowed(billing, 'review')).toBe(true);
    }
    expect(billingBlocksCredential('subscription')).toMatch(/subscription/);
  });

  it('refuses a frontier proposal once it carries a subscription billing class', () => {
    const cfg = {
      version: 1,
      roots: ['/tmp'],
      foundry: { mergeAuthority: [{ engine: 'claude', model: 'claude-sonnet-5' }] },
    } as unknown as AshlrConfig;
    const base = { id: 'p', status: 'pending', engineTier: 'frontier', engineModel: 'claude:claude-sonnet-5' } as unknown as Proposal;
    expect(evaluateMergeAuthority(base, cfg).authorized).toBe(true);
    const tagged = { ...base, billingClass: 'subscription' } as Proposal;
    const verdict = evaluateMergeAuthority(tagged, cfg);
    expect(verdict.authorized).toBe(false);
    expect(verdict.reason).toMatch(/subscription/);
    expect(evaluateMergeAuthority({ ...base, billingClass: 'local' } as Proposal, cfg).authorized).toBe(false);
    expect(evaluateMergeAuthority({ ...base, billingClass: 'loopback' } as Proposal, cfg).authorized).toBe(false);
  });
});

describe('fixture CLI output', () => {
  const catalog = loadCatalog();

  it('cools down until the fixture reset, and stays down when the reset is missing', () => {
    const limited = parseCliCooldown('codex', line('codex rate limit:'), NOW);
    expect(limited?.untilMs).toBe(Date.parse('2026-10-26T06:00:00.000Z'));
    expect(cooldownActive(limited, NOW)).toBe(true);
    expect(cooldownActive(limited, Date.parse('2026-10-26T07:00:00.000Z'))).toBe(false);
    const open = parseCliCooldown('claude', line('claude rate limit:'), NOW);
    expect(open?.untilMs).toBe(Date.parse('2026-10-26T06:00:00.000Z'));
    const unknown = parseCliCooldown('codex', line('codex rate limit no reset:'), NOW);
    expect(unknown?.untilMs).toBeNull();
    expect(cooldownActive(unknown, NOW)).toBe(true);
  });

  it('probes the account with an exec and does not trust the Codex cache', async () => {
    expect(catalog.cacheListings.codex).toContain('gpt-6.1-sol');
    const calls: string[][] = [];
    const probe = await probeModel(
      catalog,
      catalog.tiers.workhorse.find((row) => row.candidate === 'gpt-6.1-sol')!,
      runner((_bin, args) => {
        calls.push([...args]);
        return { code: 1, stdout: '', stderr: `${line('codex reject gpt-6.1-sol:')}\n` };
      }),
      { PATH: '/usr/bin', HOME: '/tmp' },
    );
    expect(probe.execCalled).toBe(true);
    expect(probe.accountStatus).toBe('rejected');
    expect(calls[0]).toContain('exec');
    expect(calls[0]).toContain('gpt-6.1-sol');
    expect(interpretModelProbe('ok\n', 0)).toBe('accepted');
  });

  it('reads grok models as metered API billing and claude auth as logged out', async () => {
    const grok = adapterById(catalog, 'grok')!;
    const text = ['You are using XAI_API_KEY', 'grok-build-0.1', 'grok-4.7'].join('\n');
    expect(FIXTURE).toContain('You are using XAI_API_KEY');
    expect(grokOutputIsMetered(text)).toBe(true);
    const availability = await probeAvailability(
      grok,
      runner((_bin, args) => {
        if (args[0] === '--version') return { code: 0, stdout: 'grok 0.1\n', stderr: '' };
        return { code: 0, stdout: `${text}\n`, stderr: '' };
      }),
      { PATH: '/usr/bin', HOME: '/tmp', XAI_API_KEY: 'must-not-pass' },
    );
    expect(availability.meteredConfirmed).toBe(true);
    expect(availability.billing).toBe('metered');
    const claude = await probeAvailability(
      adapterById(catalog, 'claude')!,
      runner((_bin, args) => {
        if (args[0] === '--version') return { code: 0, stdout: `${line('claude version:')}\n`, stderr: '' };
        return { code: 1, stdout: `${line('claude auth:')}\n`, stderr: '' };
      }),
      { PATH: '/usr/bin', HOME: '/tmp' },
    );
    expect(claude.binaryPresent).toBe(true);
    expect(claude.loggedIn).toBe('out');
  });
});

describe('worker plan', () => {
  const catalog = loadCatalog();
  const repo = '/work/phantom';
  const issues = parseIssues(JSON.stringify([
    { number: 12, title: 'Fix the parser', body: 'null pointer', labels: ['route:codex', 'bug'] },
    { number: 13, title: 'Second codex', body: '', labels: ['route:codex'] },
    { number: 14, title: 'Ask grok', body: 'draft', labels: ['route:grok'] },
    { number: 15, title: 'Anyone', body: 'spread', labels: ['route:any'] },
  ]));

  it('prints a dry-run plan and does not run metered or unpinned work', () => {
    const plan = planWorker({ catalog, issues, repo, nowMs: NOW });
    const text = formatPlan(plan);
    expect(text).toContain('dry-run');
    expect(plan.steps.find((step) => step.number === 12)).toMatchObject({
      action: 'run', backend: 'codex', billing: 'subscription', role: 'produce', model: null, pullRequest: 'draft',
    });
    expect(plan.steps.find((step) => step.number === 13)?.reason).toMatch(/concurrency cap/);
    expect(plan.steps.find((step) => step.number === 14)?.reason).toMatch(/metered/);
    expect(plan.steps.find((step) => step.number === 15)?.reason).toMatch(/seat-router/);
    const enabled = planWorker({ catalog, issues, repo, nowMs: NOW, meteredEnabled: true });
    expect(enabled.steps.find((step) => step.number === 14)?.action).toBe('run');
  });

  it('skips a backend that is inside a fixture cooldown', () => {
    const cooled = parseCliCooldown('codex', line('codex rate limit:'), NOW)!;
    const plan = planWorker({ catalog, issues: [issues[0]!], repo, nowMs: NOW, cooldowns: [cooled] });
    expect(plan.steps[0]?.action).toBe('skip');
    expect(plan.steps[0]?.reason).toMatch(/rate limit/);
  });

  it('executes only a draft PR through a fake runner and a scrubbed env', async () => {
    const plan = planWorker({ catalog, issues: [issues[0]!], repo, nowMs: NOW });
    const step = plan.steps[0]!;
    const seen: { bin: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const result = await executeStep(step, issues[0]!, catalog, runner((bin, args, env) => {
      seen.push({ bin, args, env });
      return { code: 0, stdout: 'ok', stderr: '' };
    }), {
      PATH: '/usr/bin',
      HOME: '/tmp',
      GH_TOKEN: 'ghp_secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
    }, { get: () => null });
    expect(result.ok).toBe(true);
    expect(seen.map((call) => call.bin)).toEqual(['git', 'codex', 'gh']);
    expect(seen[1]?.args[0]).toBe('exec');
    expect(seen[1]?.args).not.toContain('--model');
    const pr = seen[2]?.args ?? [];
    expect(pr.slice(0, 3)).toEqual(['pr', 'create', '--draft']);
    expect(pr).not.toContain('merge');
    expect(JSON.stringify(seen.map((call) => call.env))).not.toMatch(/ghp_secret|oauth-secret/);
  });

  it('does not log a Devin key', async () => {
    const key = 'cog_ProcessEnvOnlyKey99';
    const lookup = 'lookup-secret-key-should-not-leak';
    const sourceEnvKey = 'source-env-key-should-not-leak';
    vi.stubEnv('DEVIN_API_KEY', key);
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map((part) => String(part)).join(' '));
    }));
    let gets = 0;
    const step = {
      number: 9,
      title: 'Devin',
      action: 'run' as const,
      reason: 'pinned',
      route: 'route:any' as const,
      backend: 'devin',
      billing: 'metered' as const,
      model: null,
      role: 'produce' as const,
      accountId: null,
      poolId: null,
      worktree: '/tmp/issue-9',
      pullRequest: 'draft' as const,
    };
    const issue = { number: 9, title: 'Devin', body: 'draft a fix', labels: ['route:any'] };
    const plan = planWorker({ catalog, issues: [issue], repo, nowMs: NOW });
    const planText = formatPlan(plan);
    const result = await executeStep(step, issue, catalog, runner(() => {
      throw new Error('runner must not be called');
    }), { DEVIN_API_KEY: sourceEnvKey }, { get: () => { gets += 1; return lookup; } });
    const rendered = [planText, result.detail, result.commands.join('\n'), logs.join('\n'), JSON.stringify(result), JSON.stringify(plan)].join('\n');
    expect(gets).toBe(0);
    expect(result.detail).toMatch(/DEVIN_API_KEY|enabled for/);
    expect(result.commands).toEqual([]);
    for (const secret of [key, lookup, sourceEnvKey]) expect(rendered).not.toContain(secret);
    vi.unstubAllEnvs();
    const absent = await executeStep(step, issue, catalog, runner(() => {
      throw new Error('runner must not be called');
    }), { DEVIN_API_KEY: sourceEnvKey }, { get: () => lookup });
    expect(absent.detail).toMatch(/disabled until DEVIN_API_KEY/);
    expect(absent.detail).not.toContain(lookup);
    expect(absent.detail).not.toContain(sourceEnvKey);
    for (const spy of spies) spy.mockRestore();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('fake codex binary', () => {
  it('spawns the temp script and sees a scrubbed environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cli-'));
    const script = join(dir, 'codex');
    writeFileSync(script, `#!/usr/bin/env node
const leaked = Object.keys(process.env).filter((key) => key === 'GH_TOKEN' || key === 'OPENAI_API_KEY' || key === 'CLAUDE_CODE_OAUTH_TOKEN');
if (leaked.length) { console.error(leaked.join(',')); process.exit(3); }
if (process.argv[2] === '--version') { console.log('codex 0.164.0'); process.exit(0); }
console.error('unexpected');
process.exit(2);
`);
    chmodSync(script, 0o755);
    const result = await spawnCli(script, ['--version'], scrubAdapterEnv({
      PATH: process.env.PATH,
      HOME: dir,
      GH_TOKEN: 'ghp_secret',
      OPENAI_API_KEY: 'sk-test',
    }));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(line('codex version:'));
  });
});

describe('worker CLI dry-run', () => {
  it('prints the plan and refuses drain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-cli-issues-'));
    const issues = join(dir, 'issues.json');
    writeFileSync(issues, JSON.stringify([{ number: 3, title: 'Docs', body: '', labels: ['route:claude'] }]));
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((chunk?: unknown) => {
      logs.push(String(chunk));
    });
    const errors: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation((chunk?: unknown) => {
      errors.push(String(chunk));
    });
    try {
      expect(await cmdWorker(['--dry-run', '--issues-file', issues, '--repo', dir])).toBe(0);
      expect(logs.join('\n')).toContain('dry-run');
      expect(logs.join('\n')).toContain('claude');
      expect(logs.join('\n')).not.toContain('spawn');
      expect(await cmdWorker(['drain', '--issues-file', issues, '--repo', dir])).toBe(2);
      expect(errors.join('\n')).toMatch(/not wired/);
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
  });
});
