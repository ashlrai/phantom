import { readFileSync } from 'node:fs';

// Only the gateway tables precede the standalone fleet server section.
const catalog = readFileSync(new URL('../../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
const gateway = catalog.split('## `phantom-fleet`')[0]!;
export const contractedNativeToolNames = [...gateway.matchAll(/^\| `((?:ashlr|phm|phantom|desktop|world|intent)_[a-z0-9_]+)` \|/gm)]
  .map((match) => match[1]!)
  .sort();
