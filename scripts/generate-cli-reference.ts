import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { cmdDocsCli, cliReferenceRows } from '../src/cli/docs-cli.js';
import { HELP_ENTRIES } from '../src/cli/help.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await cmdDocsCli(process.argv.slice(2), cliReferenceRows(HELP_ENTRIES), fileURLToPath(new URL('../', import.meta.url)));
}
