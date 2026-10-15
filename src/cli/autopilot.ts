/**
 * `phm autopilot <pr> [--repo owner/name] [--checkout <dir>] [--apply] [--watch]`
 *
 * Drive one of Phantom's own pull requests to green: diagnose red CI, review
 * feedback and base conflicts; fix, merge the base or re-run infrastructure
 * failures; re-verify; stop and say why when the failure is not the PR's.
 * Without --apply it only prints the plan. See core/autopilot/act.ts.
 */
import { execFileSync } from 'node:child_process';

const USAGE = `Usage: phm autopilot <pr-number|pr-url> [options]
  --repo <owner/name>    repository (default: the checkout's origin)
  --checkout <dir>       local clone to work from (default: current directory)
  --apply                act: push fixes, merge the base, re-run infra failures (default: plan only)
  --fixer "<command>"    agent that reads the brief on stdin and edits files
                         (default: "claude -p --permission-mode acceptEdits")
  --no-fixer             never change code; only merge clean bases and re-run infra
  --verify "<command>"   run in the worktree before every push; repeatable, all must pass
  --prefix <branch-prefix>  branch prefix the autopilot owns; repeatable (adds to the defaults)
  --max-pushes <n>       pushes per PR before handing it to a person (default 6)
  --watch                tick until the PR is green, merged, closed or stopped
  --interval <seconds>   seconds between watch ticks (default 90)
  --json                 one JSON object per tick`;

export const DEFAULT_FIXER = ['claude', '-p', '--permission-mode', 'acceptEdits'];

export function parsePrRef(ref: string | undefined): { number: number; repo: string | null } | null {
  if (!ref) return null;
  const url = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(ref);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  return /^\d+$/.test(ref) ? { repo: null, number: Number(ref) } : null;
}

export function repoFromRemote(url: string): string | null {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1]! : null;
}

/** A command string → argv. Splits on whitespace; double quotes group. No shell. */
export function splitCommand(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).filter((s) => s.length > 0);
}

export async function cmdAutopilot(argv: string[]): Promise<number> {
  const args = [...argv];
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); return args.length ? 0 : 2; }
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const all = (n: string) => args.flatMap((a, i) => (a === n && args[i + 1] !== undefined ? [args[i + 1]!] : []));
  const ref = parsePrRef(args[0]);
  if (!ref) { console.error(USAGE); return 2; }
  const checkout = val('--checkout') ?? process.cwd();
  let repo = val('--repo') ?? ref.repo;
  if (!repo) {
    try { repo = repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: checkout, encoding: 'utf8' })); } catch { repo = null; }
  }
  if (!repo) { console.error('Could not tell the repository; pass --repo owner/name.'); return 2; }

  const { tick, liveGuards, DEFAULT_OWNED_PREFIXES } = await import('../core/autopilot/act.js');
  const { DEFAULT_LIMITS } = await import('../core/autopilot/diagnose.js');
  const maxPushes = val('--max-pushes') ? Number(val('--max-pushes')) : DEFAULT_LIMITS.maxPushes;
  if (!Number.isSafeInteger(maxPushes) || maxPushes < 0) { console.error('--max-pushes must be a whole number'); return 2; }
  const interval = Math.max(15, Number(val('--interval') ?? 90)) * 1000;
  const json = args.includes('--json');
  const fixer = args.includes('--no-fixer') ? null : val('--fixer') ? splitCommand(val('--fixer')!) : DEFAULT_FIXER;
  const guards = await liveGuards();
  const opts = {
    repo,
    number: ref.number,
    checkout,
    apply: args.includes('--apply'),
    fixer,
    verify: all('--verify').map(splitCommand).filter((v) => v.length),
    ownedPrefixes: [...DEFAULT_OWNED_PREFIXES, ...all('--prefix')],
    limits: { ...DEFAULT_LIMITS, maxPushes },
    guards: () => guards,
  };

  let stop = false;
  process.once('SIGINT', () => { stop = true; });
  for (;;) {
    Object.assign(guards, await liveGuards());
    const r = await tick(opts);
    if (json) console.log(JSON.stringify(r));
    else {
      console.log(`${r.plan === 'green' || r.result === 'pushed' ? 'ok' : r.plan === 'stop' ? '!' : '->'} ${repo}#${r.number} ${r.headSha.slice(0, 8)}: ${r.plan}${r.result !== 'none' ? ` (${r.result})` : ''}: ${r.reason}`);
      for (const d of r.detail) console.log(`   ${d}`);
    }
    const final = ['done', 'green', 'stop'].includes(r.plan) || (!opts.apply && r.result === 'planned');
    if (!args.includes('--watch') || final || stop) return r.plan === 'stop' || r.result === 'refused' || r.result === 'error' || r.result === 'verify-failed' ? 1 : 0;
    await new Promise((res) => setTimeout(res, interval));
  }
}
