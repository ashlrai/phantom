import { execFile } from 'node:child_process';
import { defaultGh } from '../core/autopilot/github.js';
import { dispatchReleaseTrain, openReleaseBumpPr, planReleaseTrain, type ReleaseTrainDeps, type Runner } from '../core/release-train.js';
import { scrubSecrets } from '../core/util/scrub.js';

export const RELEASE_TRAIN_USAGE = 'phm release-train plan|open|dispatch [--dry-run] [--json]';

const runner = (bin: string): Runner => (args) => new Promise((resolve, reject) => {
  execFile(bin, [...args], {
    timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  }, (err, stdout, stderr) => {
    if (err) {
      const line = String(stderr || err.message).split('\n').find((l) => l.trim()) ?? 'failed';
      reject(new Error(scrubSecrets(`${bin} ${args[0] ?? ''}: ${line}`).slice(0, 300)));
    } else resolve(stdout);
  });
});

async function defaultDeps(): Promise<ReleaseTrainDeps> {
  const { killSwitchOn } = await import('../core/sandbox/policy.js');
  return { gh: (args) => defaultGh([...args]), git: runner('git'), npm: runner('npm'), stopped: killSwitchOn };
}

export async function cmdReleaseTrain(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(RELEASE_TRAIN_USAGE + '\n'); return 0; }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const argv = args.filter((arg) => arg !== '--json' && arg !== '--dry-run');
  const unknown = argv.find((arg, index) => index > 0 && arg.startsWith('-'));
  if (unknown !== undefined || argv.length !== 1 || !['plan', 'open', 'dispatch'].includes(argv[0]!)) {
    if (unknown !== undefined) process.stderr.write(`unknown option: ${unknown}\n`);
    process.stderr.write(RELEASE_TRAIN_USAGE + '\n');
    return 2;
  }
  try {
    const deps = await defaultDeps();
    const verb = argv[0]!;
    const result = verb === 'plan' ? await planReleaseTrain(deps)
      : verb === 'open' ? await openReleaseBumpPr(deps)
      : await dispatchReleaseTrain(deps, { dryRun });
    if (json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
    else {
      if (verb === 'plan') {
        const plan = result as Awaited<ReturnType<typeof planReleaseTrain>>;
        process.stdout.write(`gate=${plan.gate} bump=${plan.bump} reason=${plan.reason}` +
          (plan.nextVersion !== null ? ` next=${plan.nextVersion} branch=${plan.prBranch}` : '') + '\n');
      } else if ('argv' in result && result.argv !== null) {
        process.stdout.write(`${result.dispatched ? 'dispatched' : 'dry-run'}: gh ${result.argv.join(' ')}\n`);
      } else {
        process.stdout.write(`ok=${result.ok} reason=${result.reason}${'prUrl' in result && result.prUrl ? ` pr=${result.prUrl}` : ''}\n`);
      }
    }
    return result.ok || verb === 'plan' ? 0 : 1;
  } catch (error) {
    const line = scrubSecrets(String((error as Error).message ?? error)).slice(0, 300);
    if (json) process.stdout.write(JSON.stringify({ ok: false, reason: 'release-train unavailable' }) + '\n');
    process.stderr.write(`release-train unavailable: ${line}\n`);
    return 1;
  }
}
