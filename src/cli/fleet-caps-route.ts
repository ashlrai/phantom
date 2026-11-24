import { CapsRegistryError, loadCapsRegistry } from '../core/caps/registry.js';
import { resolveRegistryPath } from '../core/caps/service.js';
import { routeSurfaceModel } from '../core/caps/dispatch.js';

/** Inspect registry metadata only; this command never launches a provider. */
const usage = 'Usage: phm fleet caps-route --surface <id> --model <id> [--registry <path>] --json';

export async function cmdFleetCapsRoute(args: string[]): Promise<number> {
  const options: Record<string, string> = {};
  let json = false;
  let error: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--help' || arg === '-h') && args.length === 1) {
      console.log(usage);
      return 0;
    }
    if (arg === '--json' && !json) { json = true; continue; }
    if (!['--surface', '--model', '--registry'].includes(arg) || options[arg] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      error = 'Unknown, duplicate, or missing option value.'; break;
    }
    options[arg] = args[++i];
  }
  if (!options['--surface'] || !options['--model'] || !json) error ??= 'Options --surface, --model and --json are required.';
  if (error) { console.log(JSON.stringify({ ok: false, reason: error })); return 2; }
  try {
    const registry = await loadCapsRegistry(resolveRegistryPath(options['--registry']));
    const result = routeSurfaceModel(registry, options['--surface'], options['--model']);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (cause) {
    const issues = cause instanceof CapsRegistryError ? cause.issues : [{ path: '(file)', message: 'Registry file could not be read.' }];
    console.log(JSON.stringify({ ok: false, issues }));
    return 1;
  }
}
