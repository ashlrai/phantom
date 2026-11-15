import { listLeaderFiles } from '../core/fleet/library-files.js';

export async function cmdLibrary(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log('phm library list [--json] — list leader files (read-only)');
    return 0;
  }
  if (args[0] !== 'list' || args.slice(1).some(arg => arg !== '--json') || args.length > 2) {
    console.error('Usage: phm library list [--json]');
    return 2;
  }
  const files = await listLeaderFiles();
  if (args.includes('--json')) console.log(JSON.stringify({ files }));
  else for (const file of files) console.log(`${file.name}  ${file.size} bytes  ${file.modifiedAt}\n  ${file.preview}`);
  return 0;
}
