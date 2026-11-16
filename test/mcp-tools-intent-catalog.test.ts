import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listNativeTools } from '../src/core/mcp-native.js';

// Catalog lock for the intent_* family: docs/MCP-TOOLS.md promises "every tool
// name and description comes directly from the source definition". The contract
// helper (test/helpers/native-tool-contract.ts) only checks names, so a row
// with a stale or paraphrased description would still pass m31. This suite pins
// the exact description string for each registered intent_* tool and refuses
// rows that name tools the gateway no longer registers.
const doc = readFileSync(join(process.cwd(), 'docs', 'MCP-TOOLS.md'), 'utf8');
const intentSection = doc.split('## `intent_`')[1]?.split('\n## ')[0] ?? '';
const docRows = new Map(
  [...intentSection.matchAll(/^\| `(intent_[a-z0-9_]+)` \| (.+) \|$/gm)]
    .map((match) => [match[1]!, match[2]!] as const),
);
const registeredIntentTools = listNativeTools().filter((tool) => tool.name.startsWith('intent_'));

describe('intent_* tools are cataloged in docs/MCP-TOOLS.md', () => {
  it('every registered intent_* tool has a doc row', () => {
    expect(registeredIntentTools.length).toBeGreaterThan(0);
    for (const tool of registeredIntentTools) {
      expect(docRows.has(tool.name), `${tool.name} is registered but missing from the intent_ table`).toBe(true);
    }
  });

  it('each doc row carries the exact source description', () => {
    for (const tool of registeredIntentTools) {
      expect(docRows.get(tool.name), `${tool.name} description drifted from source`).toBe(tool.description);
    }
  });

  it('no doc row names an unregistered intent_* tool', () => {
    const registered = new Set(registeredIntentTools.map((tool) => tool.name));
    for (const name of docRows.keys()) {
      expect(registered.has(name), `${name} is cataloged but not registered`).toBe(true);
    }
  });
});
