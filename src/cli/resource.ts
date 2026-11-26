import { buildProviderCards, formatProviderCards } from '../core/fabric/provider-cards.js';
import { writeResourceView } from '../core/fabric/resource-view-store.js';

const USAGE = [
  'phm resource [--cards] [--json] [--directory <fleet-directory>]',
  'Refresh resource.v1 in $ASHLR_HOME/fleet.json (default ~/.ashlr) from recorded inputs. Unknown inputs remain unknown.',
  '--cards groups pools into provider cards (OpenAI, Anthropic, Cognition / Devin, xAI), as shown in the web console.',
].join('\n') + '\n';

const USAGE_ERROR = 'Invalid resource arguments. Use phm resource --help.';
const STORAGE_ERROR = 'Resource view unavailable: fleet storage is busy, unsafe or invalid. Check that $ASHLR_HOME (default ~/.ashlr) is an owned 0700 directory and not a symbolic link.';

function writeError(json: boolean, code: 'usage' | 'storage-unavailable', message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
    return;
  }
  process.stderr.write(`${message}\n`);
}

export async function cmdResource(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  const cardsMode = args.includes('--cards');
  let directory: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json' || args[i] === '--cards') continue;
    if (args[i] === '--directory' && directory === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      directory = args[++i];
      continue;
    }
    writeError(json, 'usage', USAGE_ERROR);
    return 2;
  }
  try {
    const view = writeResourceView(directory);
    if (cardsMode) {
      const cards = buildProviderCards(view);
      process.stdout.write(json ? JSON.stringify(cards, null, 2) + '\n' : formatProviderCards(cards));
      return 0;
    }
    process.stdout.write(json ? JSON.stringify(view, null, 2) + '\n'
      : view.pools.map(pool => `${pool.pool}: ${pool.status}, used ${pool.pctUsed === null ? 'unknown' : `${pool.pctUsed}%`}, pace ${pool.paceRatio === null ? 'unknown' : `${pool.paceRatio.toFixed(2)}x`}`).join('\n') + '\n');
    return 0;
  } catch {
    writeError(json, 'storage-unavailable', STORAGE_ERROR);
    return 1;
  }
}
