import { installTool } from '../core/install/installer.js';
import { InstallError } from '../core/install/storage.js';

const usage = 'phm install <url|owner/repo|name> [--dir <project>] [--dry-run] [--json]';

export async function cmdInstall(args: string[]): Promise<number> {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    console.log(json ? JSON.stringify({ usage, client: 'Claude Code project .mcp.json' }) : `${usage}\nInstall a Node tool and its declared MCP server into this project.\n--dry-run resolves and validates without writing or running installers.\n--dir selects an existing project directory. Secrets are vault names only.`);
    return 0;
  }
  let input: string | undefined;
  let dir: string | undefined;
  let dryRun = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--json') continue;
      if (arg === '--dry-run') { dryRun = true; continue; }
      if (arg === '--dir') {
        if (dir || !args[i + 1] || args[i + 1]!.startsWith('-')) throw new InstallError('Expected one project directory after --dir.');
        dir = args[++i]; continue;
      }
      if (arg.startsWith('-') || input) throw new InstallError(`Usage: ${usage}`);
      input = arg;
    }
    if (!input) throw new InstallError(`Usage: ${usage}`);
    const result = await installTool(input, { dir, dryRun });
    console.log(json ? JSON.stringify({ ok: result.status !== 'needs-secrets', ...result }) : [
      `${result.manifest.id}: ${result.status}`, ...result.actions.map(action => `  ${action}`),
      ...(result.status === 'needs-secrets' ? ['Secret bindings are pending. Configure the named references through your vault integration; no changes made.'] : []),
      ...(result.config ? [`MCP config: ${result.config}`] : []),
    ].join('\n'));
    return result.status === 'needs-secrets' ? 2 : 0;
  } catch (error) {
    // Metadata and subprocess errors may carry remote content. Only our fixed diagnostics are public.
    const message = error instanceof InstallError ? error.message : 'Installation failed. Check the source, manifest, prerequisites and project permissions.';
    console.log(json ? JSON.stringify({ ok: false, schema: 'phantom.install.result.v1', status: 'failed', error: message }) : message);
    return 1;
  }
}
