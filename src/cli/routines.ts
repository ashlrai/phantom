import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { load, migrate, run, status, launchdPlist } from '../core/routines/index.js';

const usage = `Usage: phm routines list|status|run <id>|tick|migrate <id> "<cron or prompt>"|launchd [--file <yaml>]
list validates definitions; status generates STATUS.md; tick runs due UTC schedules.
launchd prints a single minute-cadence LaunchAgent definition (does not install it).`;
export async function runRoutinesCli(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(usage); return 0; }
  const args = [...argv];
  const index = args.indexOf('--file');
  let file: string | undefined;
  if (index !== -1) {
    if (!args[index + 1]) { console.error(usage); return 2; }
    file = resolve(args[index + 1]!); args.splice(index, 2);
  }
  const [verb, name, text] = args;
  if (!['list', 'status', 'run', 'tick', 'migrate', 'launchd'].includes(verb!) || args.length !== (verb === 'migrate' ? 3 : verb === 'run' ? 2 : 1)) { console.error(usage); return 2; }
  try {
    if (verb === 'migrate') { await migrate(text!, name!, file); return 0; }
    if (verb === 'launchd') {
      if (!file || !import.meta.url.endsWith('.js')) throw new Error('Use the built CLI and an absolute --file path');
      console.log(launchdPlist(process.execPath, fileURLToPath(new URL('./index.js', import.meta.url)), file)); return 0;
    }
    const config = await load(file);
    if (verb === 'list') { console.log(config.routines.map(r => `${r.id}\t${r.schedule}\t${r.tier}`).join('\n')); return 0; }
    if (verb === 'status') { console.log(await status(config)); return 0; }
    const attempts = await run(config, verb === 'run' ? name : undefined);
    console.log(JSON.stringify({ attempts }));
    return verb === 'run' && !attempts.some(a => a.outcome === 'success' || a.outcome === 'submitted') ? 1 : 0;
  } catch { console.error('Routines operation failed. Check definitions, executor login, limits and the local lock; provider diagnostics are never printed.'); return 1; }
}
