import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFleetMemoryFiles } from '../src/core/fleet/memory-files.js';
import { memoryView } from '../src/core/fleet/memory-view.js';
import { narrowFleetMemory } from '../src/web-ui/routes/verse/fleet-host/memory-guard-query.js';

const script = `import sys
sys.path.insert(0, sys.argv[1])
import host_session_tick
host_session_tick.tick(sys.argv[2], roots_provider=lambda runs: [{'job':'RQ-1','path':sys.argv[3]}], now=1000, census=lambda: [], boot=lambda: 'boot', pressure=lambda: {'state':'normal','level':1})
`;

describe('session writer to card transport', () => {
  it('reads the actual tick output through the memory reader and typed card projection', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-projection-')));
    try {
      const runs = join(dir, 'runs'); const tree = join(dir, 'tree');
      mkdirSync(runs, { mode: 0o700 }); mkdirSync(tree, { mode: 0o700 });
      writeFileSync(join(tree, 'file'), 'payload');
      execFileSync('python3', ['-c', script, resolve('contrib/mac'), runs, tree], { timeout: 10_000 });
      const files = await readFleetMemoryFiles(runs);
      const now = Date.now();
      const memory = memoryView(files.memstat, files.memguard, now, files.resourceSession);
      const card = narrowFleetMemory({ v: 1, generatedAt: new Date(now).toISOString(), memory });
      expect(card?.memory.resource_session?.disk.state).toBe('history');
      expect(card?.memory.resource_session?.disk.allocatedBytes).toBeGreaterThan(0);
      expect(card?.memory.resource_session?.disk.provenance).toContain('Historical');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
