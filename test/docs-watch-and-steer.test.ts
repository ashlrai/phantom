import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const verse = readFileSync(join(process.cwd(), 'docs/VERSE.md'), 'utf8');
const desktop = readFileSync(join(process.cwd(), 'DESKTOP.md'), 'utf8');

describe('watch and steer documentation', () => {
  it('places the guides in the specified navigation order', () => {
    const watch = verse.indexOf('## Watch and steer the fleet (3.30)');
    expect(watch).toBeGreaterThanOrEqual(0);
    expect(verse.indexOf('## Fleet ▸ Advanced', watch)).toBeGreaterThan(watch);
    const window = desktop.indexOf('## The Phantom window');
    const desktopWatch = desktop.indexOf('## Watch and steer');
    expect(window).toBeGreaterThanOrEqual(0);
    expect(desktopWatch).toBeGreaterThan(window);
    expect(desktop.indexOf('## Desktop control', desktopWatch)).toBeGreaterThan(desktopWatch);
    expect(desktop).toContain('docs/VERSE.md#watch-and-steer-the-fleet-330');
  });

  it('names the switches, APIs and inbox in the guides', () => {
    const section = verse.slice(verse.indexOf('## Watch and steer the fleet (3.30)'), verse.indexOf('## Fleet ▸ Advanced'));
    for (const name of ['HOLD', 'PAUSE', 'ORCH_OFF', 'OPUS_LEADER_OFF', 'PUBLISH_HOLD', 'queue/DISABLE',
      '/api/verse/fleet/runs', '/api/verse/ops/self-update', 'MASON-INBOX.md']) {
      expect(section).toContain(name);
    }
    expect(desktop).toContain('MASON-INBOX.md');
  });

  it('lists the fleet modules in the local module map', () => {
    const map = verse.slice(verse.indexOf('## Local module map'));
    expect(verse).toContain('## Local module map');
    expect(map).toContain('src/core/verse/fleet-runs-api.ts');
    expect(map).toContain('src/core/fleet/runs-dir-state.ts');
  });

  it('does not include secret-looking text', () => {
    for (const document of [verse, desktop]) {
      expect(document).not.toMatch(/sk-[A-Za-z0-9]{20,}|ghp_/);
    }
  });
});
