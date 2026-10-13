/**
 * Real effects for `runEcosystemUp` (src/core/ecosystem/onboard.ts). Loaded
 * lazily by the CLI, MCP and web surfaces. Only `signGrant` can raise
 * authority, and only the CLI wires it (Touch ID through the custody helper).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EcosystemDeps, ExecResult, GrantState } from './onboard.js';

function exec(bin: string, args: readonly string[], cwd?: string, timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolveExec) => {
    const child = spawn(bin, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolveExec({ code: 127, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolveExec({ code: code ?? 1, stdout, stderr }); });
  });
}

/** Read-only argv guard: probes may only be `gh auth status` and `gh api` GETs. */
export function isReadOnlyProbe(bin: 'gh' | 'git', args: readonly string[]): boolean {
  if (bin !== 'gh') return false;
  if (args[0] === 'auth' && args[1] === 'status') return true;
  return args[0] === 'api' && args.length === 2 && !args[1]!.startsWith('-');
}

export async function realEcosystemDeps(opts: { withGrant: boolean; confirm?: (q: string) => Promise<boolean> }): Promise<EcosystemDeps> {
  const policy = await import('../sandbox/policy.js');
  const automations = await import('../automations/index.js');
  const deps: EcosystemDeps = {
    now: () => new Date(),
    exists: existsSync,
    run: async (bin, args, cwd) => {
      if (!isReadOnlyProbe(bin, args)) return { code: 2, stdout: '', stderr: 'refused: not a read-only probe' };
      return exec(bin, args, cwd, 30_000);
    },
    clone: async (nameWithOwner, dest) => {
      mkdirSync(dirname(dest), { recursive: true });
      return exec('gh', ['repo', 'clone', nameWithOwner, dest]);
    },
    listEnrolled: () => policy.listEnrolled(),
    enroll: (path) => {
      const r = policy.enroll(path);
      return { ok: r.ok, changed: r.changed, ...(r.ok ? {} : { reason: (r as { reason?: string }).reason ?? 'refused' }) };
    },
    grantState: async (): Promise<GrantState> => {
      const { evaluateStandingAuthority, displaySurfaceTarget } = await import('../authority/effective-config.js');
      const { grantHasEliteDirect } = await import('../authority/elite-models.js');
      const ev = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
      const g = ev.grant;
      const state: GrantState['state'] = ev.grantState === 'active' ? 'active' : ev.grantState === 'none' ? 'none' : ev.grantState === 'paused' ? 'paused' : ev.grantState === 'expired' ? 'expired' : 'unknown';
      return { state, repos: g ? g.repos.map((r) => r.nameWithOwner) : [], grantSeq: g?.grantSeq ?? null, eliteDirect: g ? grantHasEliteDirect(g) : false };
    },
    automations: {
      list: async () => (await automations.automationsOverview({ schedulerRunning: false })).automations.map((a) => ({ id: a.automation.id, name: a.automation.name, enabled: a.automation.enabled })),
      createFromTemplate: async (templateId, name) => {
        const template = automations.automationTemplate(templateId);
        if (!template) throw new Error(`unknown automation template ${templateId}`);
        const created = await automations.createAutomation({ ...template.input, name, enabled: false });
        return { id: created.id };
      },
      enable: async (id) => { await automations.enableAutomation(id); },
    },
    residentState: async () => (await import('../../cli/authority.js')).realDaemonService(true),
  };
  if (opts.withGrant) {
    if (opts.confirm) deps.confirm = opts.confirm;
    deps.signGrant = async ({ eliteDirect }) => {
      const { runAuthorityCli } = await import('../../cli/authority.js');
      const lines: string[] = [];
      const code = await runAuthorityCli(['grant', '--yes', eliteDirect ? '--elite-direct' : '--no-elite-direct'], {
        out: (l: string) => { lines.push(l); process.stdout.write(`    ${l}\n`); },
        err: (l: string) => { lines.push(l); process.stderr.write(`    ${l}\n`); },
      });
      const last = lines.filter((l) => l.trim()).pop() ?? '';
      return { ok: code === 0, detail: code === 0 ? last : `not signed: ${last}` };
    };
  }
  return deps;
}
