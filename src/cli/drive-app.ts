import { createAppAdapters, DRIVE_TARGETS, loopbackAppRequest, loopbackDeskCall, type AppAction, type DriveTarget } from '../core/drive/apps.js';
import { scrubSecrets } from '../core/util/scrub.js';

export async function cmdDriveApp(args: string[]): Promise<number> {
  try {
    const [target, action, ...flags] = args;
    if (!DRIVE_TARGETS.includes(target as DriveTarget) || !['start', 'status', 'send-prompt', 'read-result'].includes(action!)) throw new Error('Invalid action');
    const options: Record<string, string> = {};
    for (let i = 0; i < flags.length; i++) {
      const key = flags[i]!;
      if (key === '--json' && !options[key]) { options[key] = 'true'; continue; }
      if (!['--prompt', '--handle', '--seat', '--project'].includes(key) || options[key] || !flags[i + 1] || flags[i + 1]!.startsWith('--')) throw new Error('Invalid option');
      options[key] = flags[++i]!;
    }
    if (!options['--json']) throw new Error('--json required');
    const request = loopbackAppRequest(process.env['PHM_DRIVE_ORIGIN'] ?? 'http://127.0.0.1:7777', process.env['PHM_DRIVE_READ_TOKEN'] ?? '', process.env['PHM_DRIVE_MUTATION_TOKEN'] ?? '');
    const bearer = process.env['PHM_DRIVE_DESK_BEARER'];
    const desk = bearer ? loopbackDeskCall(process.env['PHM_DRIVE_ORIGIN'] ?? 'http://127.0.0.1:7777', bearer) : undefined;
    const result = await createAppAdapters({ request, desk })[target as DriveTarget]({ target: target as DriveTarget, action: action as AppAction,
      prompt: options['--prompt'], handle: options['--handle'], seat: options['--seat'], projectPath: options['--project'] ?? process.cwd() });
    console.log(scrubSecrets(JSON.stringify(result)));
    return (result as { ok?: boolean }).ok === false ? 1 : 0;
  } catch {
    console.log(JSON.stringify({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' }));
    return 1;
  }
}
