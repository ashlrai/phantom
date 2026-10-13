/**
 * `ashlr ecosystem up|status` (alias `phm ecosystem up`) — one command that lets
 * Phantom work autonomously across the whole Ashlr ecosystem.
 * Engine: src/core/ecosystem/onboard.ts. Docs: docs/ECOSYSTEM-ONBOARDING.md.
 */
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { grantScopeLines, runEcosystemUp, ECOSYSTEM_REPOS, type EcosystemDeps, type EcosystemReportV1, type StepStatus } from '../core/ecosystem/onboard.js';
import { isTty, makeColors, pad } from './ui.js';

export const ECOSYSTEM_UP_USAGE = [
  'Usage: ashlr ecosystem up [--yes] [--dry-run] [--json] [--workspace <dir>] [--repos a,b] [--no-clone] [--no-schedule]',
  '       ashlr ecosystem status [--json] [--workspace <dir>]',
  '',
  '  up       Find or clone every ecosystem repo, enroll them, check GitHub gates,',
  '           sign one standing grant (Touch ID) and turn on the steward schedule.',
  '           Safe to rerun: finished steps report "already".',
  '  status   The same checks, read-only (what `up` would do next).',
  '',
  `  Repos: ${ECOSYSTEM_REPOS.map((r) => r.name).join(', ')}`,
  '  Workspace: --workspace, else $ASHLR_ECOSYSTEM_ROOT, else ~/ashlr',
].join('\n');

interface UpArgs { sub: 'up' | 'status'; yes: boolean; dryRun: boolean; json: boolean; workspace?: string; repos?: string[]; noClone: boolean; noSchedule: boolean; help: boolean; error?: string }

export function parseUpArgs(args: readonly string[]): UpArgs {
  const out: UpArgs = { sub: args[0] === 'status' ? 'status' : 'up', yes: false, dryRun: false, json: false, noClone: false, noSchedule: false, help: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--no-clone') out.noClone = true;
    else if (a === '--no-schedule') out.noSchedule = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--workspace' || a === '--root') {
      const v = args[++i]; if (!v || v.startsWith('--')) { out.error = `${a} requires a directory`; break; }
      out.workspace = resolve(v);
    } else if (a === '--repos') {
      const v = args[++i]; if (!v) { out.error = '--repos requires a comma list'; break; }
      const names = v.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = names.filter((n) => !ECOSYSTEM_REPOS.some((r) => r.name === n));
      if (bad.length) { out.error = `unknown ecosystem repo(s): ${bad.join(', ')}`; break; }
      out.repos = names;
    } else { out.error = `unknown flag: ${a}`; break; }
  }
  return out;
}

const ICON: Record<StepStatus, string> = { done: '✓', already: '✓', 'waiting-on-you': '→', failed: '✗', skipped: '·', planned: '○' };

export function renderEcosystemReport(report: EcosystemReportV1, tty = isTty()): string {
  const { bold, dim, green, yellow, red, cyan } = makeColors(tty);
  const color = (s: StepStatus, t: string) => (s === 'done' || s === 'already' ? green(t) : s === 'failed' ? red(t) : s === 'skipped' ? dim(t) : yellow(t));
  const lines: string[] = [''];
  lines.push(`  ${bold('Ashlr ecosystem')} ${dim(`· ${report.mode} · ${report.workspace.replace(homedir(), '~')}`)}`, '');
  for (const s of report.steps) {
    lines.push(`  ${color(s.status, ICON[s.status])} ${pad(s.step, 10)} ${color(s.status, pad(s.status, 15))} ${s.detail}`);
    if (s.command && s.status !== 'done' && s.status !== 'already') lines.push(`  ${' '.repeat(28)}${cyan(s.command)}`);
  }
  lines.push('', `  ${bold(pad('repo', 16))} ${pad('disk', 11)} ${pad('enrolled', 9)} ${pad('automerge', 10)} ${pad('CI gate', 9)} grant`);
  for (const r of report.repos) {
    const yn = (v: boolean | null) => (v === null ? dim('?') : v ? green('yes') : red('no'));
    const gate = r.requiredChecks === null ? dim('?') : r.verifyRequired ? red('verify') : r.requiredChecks.length ? green(`${r.requiredChecks.length} chk`) : red('none');
    lines.push(`  ${pad(r.name, 16)} ${pad(r.present, 11)} ${pad(r.enrolled ? 'yes' : 'no', 9)} ${pad(r.autoMerge === null ? '?' : r.autoMerge ? 'yes' : 'no', 10)} ${pad(gate, 9)} ${yn(r.inGrant)}`);
  }
  const fixes = report.repos.flatMap((r) => r.fixes.map((f) => ({ repo: r.name, ...f })));
  if (fixes.length) {
    lines.push('', `  ${bold('Fix')}`);
    for (const f of fixes) lines.push(`  ${yellow('→')} ${f.repo}: ${f.why}`, `      ${cyan(f.command)}`);
  }
  lines.push('', report.ready ? `  ${green('Ready.')} Phantom is working the whole ecosystem.` : `  ${bold('Next:')} ${cyan(report.nextCommand ?? 'see the rows above')}`, '');
  return lines.join('\n');
}

async function ttyConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`  ${question} [y/N] `)).trim()); } finally { rl.close(); }
}

export async function cmdEcosystemUp(args: string[], injected?: EcosystemDeps): Promise<number> {
  const parsed = parseUpArgs(args);
  if (parsed.help) { process.stdout.write(`${ECOSYSTEM_UP_USAGE}\n`); return 0; }
  if (parsed.error) { process.stderr.write(`${parsed.error}\n${ECOSYSTEM_UP_USAGE}\n`); return 2; }
  const statusOnly = parsed.sub === 'status';
  const interactive = !parsed.json && !parsed.yes && process.stdin.isTTY === true;
  const deps = injected ?? await (await import('../core/ecosystem/onboard-deps.js')).realEcosystemDeps({
    withGrant: !statusOnly && !parsed.dryRun,
    confirm: async (q) => {
      // The one confirmation: show the whole scope first.
      const names = ECOSYSTEM_REPOS.filter((r) => !parsed.repos || parsed.repos.includes(r.name)).map((r) => `ashlrai/${r.name}`);
      process.stdout.write(`\n${grantScopeLines(names).map((l) => `    ${l}`).join('\n')}\n\n`);
      return interactive ? ttyConfirm(q) : false;
    },
  });
  const report = await runEcosystemUp(deps, {
    ...(parsed.workspace ? { workspace: parsed.workspace } : {}),
    ...(parsed.repos ? { repos: parsed.repos } : {}),
    dryRun: parsed.dryRun, statusOnly, yes: parsed.yes, noClone: parsed.noClone, noSchedule: parsed.noSchedule,
  });
  if (parsed.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(renderEcosystemReport(report));
  if (statusOnly || parsed.dryRun) return 0;
  return report.steps.some((s) => s.status === 'failed') ? 1 : 0;
}
