import { amplifyRunsDir, amplifyTick, readAmplifyGoal, readAmplifyStatus } from '../core/amplify/index.js';
const USAGE = 'Usage: phm amplify status|tick|goal [--json] [--limit 1..100 (goal only)]';
export async function cmdAmplify(args: string[], deps = { root: amplifyRunsDir(), now: Date.now }) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const [verb, ...flags] = args;
  let json = false, limit = 10;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (seen.has(flag)) { console.error(USAGE); return 2; }
    seen.add(flag);
    if (flag === '--json') json = true;
    else if (flag === '--limit' && verb === 'goal' && /^(?:[1-9]\d?|100)$/.test(flags[i + 1] ?? '')) limit = Number(flags[++i]);
    else { console.error(USAGE); return 2; }
  }
  if (!verb || !['status', 'tick', 'goal'].includes(verb)) { console.error(USAGE); return 2; }
  try {
    const result = verb === 'goal' ? await readAmplifyGoal(deps.root, limit)
      : verb === 'tick' ? await amplifyTick(deps.root, deps.now()) : await readAmplifyStatus(deps.root, deps.now());
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(result.objective);
      if ('actions' in result) {
        for (const p of result.pools) console.log(`${p.pool}: used=${p.used_pct ?? '?'}% burn=${p.burn_pct_per_hour ?? '?'}/h waste=${p.projected_waste_pct ?? '?'}% saturation=${p.saturation ?? '?'} (${p.state})`);
        for (const a of result.actions) console.log(`ADVISORY ${a.pool ?? 'fleet'}: ${a.recommendation}`);
      } else for (const d of result.decisions) console.log(`${d.at}: ${d.decision}`);
    }
    return 0;
  } catch { console.error('Unable to read amplify evidence or append advisory journal.'); return 1; }
}
