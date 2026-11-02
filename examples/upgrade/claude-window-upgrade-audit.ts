#!/usr/bin/env -S npx tsx
/* global process */
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readResourceLedger } from '../../src/core/fleet/runs-resource-ledger.js';

type Dependencies = {
  read?: typeof readResourceLedger;
  write?: (text: string) => void;
};
const usage = 'npx tsx examples/upgrade/claude-window-upgrade-audit.ts --scratch-dir /absolute/empty/directory';
const at = '2026-10-31T12:00:00Z';
const reset = '2026-11-07T12:00:00Z';
const shortKey = /(?:five|5)[_\s-]*(?:hours?|hrs?|h)(?:[_\s-]|[A-Z]|$)|(?:messages|tokens)[_\s-]*5h/i;
const inside = (parent: string, path: string) => {
  const rel = relative(parent, path);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
};

/** Run a fake, isolated compatibility fixture through this tree's public reader. */
export async function run(args: readonly string[], deps: Dependencies = {}): Promise<number> {
  const emit = (value: unknown) => (deps.write ?? (text => process.stdout.write(text)))(JSON.stringify(value) + '\n');
  if (args.length === 1 && args[0] === '--help') { emit({ v: 1, usage }); return 0; }
  const root = args[1];
  if (args.length !== 2 || args[0] !== '--scratch-dir' || !root || !isAbsolute(root)
      || root.length > 4096 || root !== root.trim() || /\p{Cc}/u.test(root)
      || root.split(/[\\/]+/).some(part => part === '..' || part === '.codex' || part === '.codex-2')) {
    emit({ v: 1, error: 'invalid_arguments' }); return 2;
  }
  let scratch: string;
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error();
    scratch = await realpath(root);
    const homes = await Promise.all([realpath(homedir()), realpath(userInfo().homedir)]);
    if (scratch === parse(scratch).root || homes.some(home => inside(home, scratch) || inside(scratch, home))
        || scratch.split(/[\\/]+/).some(part => part === '.codex' || part === '.codex-2')
        || (await readdir(scratch)).length !== 0) throw new Error();
  } catch {
    emit({ v: 1, error: 'invalid_scratch_directory' }); return 2;
  }
  try {
    const queue = join(scratch, 'queue');
    const personal = join(scratch, 'fake-personal-home');
    await mkdir(queue);
    await mkdir(personal);
    await writeFile(join(queue, 'status.json'), JSON.stringify({
      last_tick: at,
      lanes: { claude: { running: 0, target: 1, held: false }, 'claude-api': {}, 'codex-personal': {} },
      budget: {
        claude: { five_hour_used_pct: 99, fiveHourPct: 98, messages_5h: 80, five_hour_reset_at: '2026-10-31T14:00:00Z' },
        'claude-api': { credits_remaining: 25 },
        'codex-personal': { weekly_used_pct: 42, reset_at: reset },
      },
    }), { flag: 'wx' });
    const ledger = await (deps.read ?? readResourceLedger)({ runsDir: scratch, personalCodexHome: personal, now: () => Date.parse(at) });
    if (ledger.sources.status !== 'healthy') { emit({ v: 1, result: 'inconclusive', reason: 'status_unavailable' }); return 3; }
    const claude = ledger.lanes.filter(row => row.lane === 'claude');
    const api = ledger.lanes.filter(row => row.lane === 'claude-api');
    const codex = ledger.lanes.filter(row => row.lane === 'codex-personal');
    if (claude.length !== 1 || api.length !== 1 || codex.length !== 1) {
      emit({ v: 1, result: 'inconclusive', reason: 'missing_lane_evidence' }); return 3;
    }
    const c = claude[0]!;
    const checks = {
      claude: c.window === 'weekly' && c.usedPct === null && c.resetAt === null && c.creditsRemaining === null
        && c.burnPctPerHour === null && c.tokensPerHour6h === null && c.projectedExhaustion === null
        && !Object.keys(c).some(key => shortKey.test(key)),
      apiCredits: api[0]!.window === 'credits' && api[0]!.creditsRemaining === 25,
      codexWeekly: codex[0]!.window === 'weekly' && codex[0]!.usedPct === 42 && codex[0]!.resetAt === reset,
    };
    const ok = Object.values(checks).every(Boolean);
    emit({ v: 1, result: ok ? 'verified' : 'mismatch', checks });
    return ok ? 0 : 1;
  } catch {
    emit({ v: 1, error: 'audit_failed' }); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
