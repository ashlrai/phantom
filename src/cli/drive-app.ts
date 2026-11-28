import {
  createAppAdapters,
  DEFAULT_DRIVE_ORIGIN,
  isAppAction,
  isDriveTarget,
  loopbackAppRequest,
  loopbackDeskCall,
} from '../core/drive/apps.js';
import { readEnvironmentCredential } from '../core/integrations/secrets.js';
import { scrubSecrets } from '../core/util/scrub.js';

export async function cmdDriveApp(args: string[]): Promise<number> {
  try {
    const [target, action, ...flags] = args;
    if (!isDriveTarget(target) || !isAppAction(action)) throw new Error('Invalid action');
    const options: Record<string, string> = {};
    for (let i = 0; i < flags.length; i++) {
      const key = flags[i]!;
      if (key === '--json' && !options[key]) { options[key] = 'true'; continue; }
      if (!['--prompt', '--handle', '--seat', '--project'].includes(key) || options[key] || !flags[i + 1] || flags[i + 1]!.startsWith('--')) throw new Error('Invalid option');
      options[key] = flags[++i]!;
    }
    if (!options['--json']) throw new Error('--json required');
    const origin = process.env['PHM_DRIVE_ORIGIN'] ?? DEFAULT_DRIVE_ORIGIN;
    const request = loopbackAppRequest(origin, readEnvironmentCredential('PHM_DRIVE_READ_TOKEN') ?? '', readEnvironmentCredential('PHM_DRIVE_MUTATION_TOKEN') ?? '');
    // DESK is wired only when a live chat-turn bearer is configured; the bearer is never printed.
    const bearer = process.env['PHM_DRIVE_DESK_BEARER'];
    const desk = bearer ? loopbackDeskCall(origin, bearer) : undefined;
    const result = await createAppAdapters({ request, desk })[target]({ target, action,
      prompt: options['--prompt'], handle: options['--handle'], seat: options['--seat'], projectPath: options['--project'] ?? process.cwd() });
    console.log(scrubSecrets(JSON.stringify(result)));
    return (result as { ok?: boolean }).ok === false ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' }));
    return 1;
  }
}
