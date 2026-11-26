import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

it('loads production Verse panes without Node storage globals', () => {
  const root = mkdtempSync(join(tmpdir(), 'phantom-verse-bundle-'));
  const home = join(root, 'home');
  const ashlrHome = join(root, 'ashlr');
  const out = join(root, 'web');
  const env = { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: ashlrHome, ASHLR_RUNS_DIR: join(root, 'runs') };
  const run = (args: string[]) => execFileSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' });
  try {
    mkdirSync(home);
    mkdirSync(ashlrHome);
    run(['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.config.web.ts', '--outDir', out, '--logLevel', 'error']);
    // The Vite output has browser externals for Node builtins. A fresh process
    // also removes Buffer so the original private-storage failure can't pass.
    run(['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const out = process.argv[1];
      const manifest = JSON.parse(await readFile(join(out, '.vite/manifest.json'), 'utf8'));
      delete globalThis.Buffer;
      for (const [source, name] of [
        ['routes/verse/home/HomePane.tsx', 'HomePane'],
        ['routes/verse/sections/CommandSection.tsx', 'CommandSection'],
        ['routes/verse/fleet-metrics/MetricsPane.tsx', 'MetricsPane'],
        ['routes/verse/goals-pane/GoalsPane.tsx', 'GoalsPane'],
        ['routes/verse/leader-thread/LeaderSurface.tsx', 'LeaderSurface'],
        ['routes/verse/mobile/screens/GoalsScreen.tsx', 'GoalsScreen'],
        ['routes/verse/mobile/screens/HomeGlance.tsx', 'HomeGlance'],
        ['routes/verse/mobile/screens/LeaderScreen.tsx', 'LeaderScreen'],
        ['routes/verse/mobile/screens/NeedsYouScreen.tsx', 'NeedsYouScreen'],
      ]) {
        const chunk = manifest[source];
        const pane = await import(pathToFileURL(join(out, chunk.file)).href);
        assert.equal(typeof pane[name], 'function', source);
      }
    `, out]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 65_000);
