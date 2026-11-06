import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildFleetVerbCatalog, inferVerbEffect, type FleetVerbEffect } from '../src/core/fleet/fleet-verb-catalog.js';

const EFFECTS: readonly FleetVerbEffect[] = ['read', 'apply-gated', 'writes', 'unknown'];

function realSource(verb: string): string | null {
  try { return readFileSync(new URL(`../src/cli/fleet-${verb}.ts`, import.meta.url), 'utf8'); }
  catch { return null; }
}

describe('fleet verb catalog effect inference', () => {
  it('marks a verb with no write signals as read', () => {
    const source = "const usage = 'Usage: ashlr fleet merge-pace [--json]';\n"
      + "import { readFile } from 'node:fs/promises';\n"
      + 'export async function cmdFleetMergePace() { console.log((await readFile("m", "utf8")).length); return 0; }';
    expect(inferVerbEffect(source)).toBe('read');
  });

  it('marks an --apply-flag verb as apply-gated even when it can write', () => {
    const source = "const usage = 'Usage: ashlr fleet stray-stop [--apply]';\n"
      + "if (arg === '--apply') apply = true;\n"
      + 'if (apply) await killStray(pid);';
    expect(inferVerbEffect(source)).toBe('apply-gated');
  });

  it('marks a direct node:fs write as writes', () => {
    const source = "import { writeFile } from 'node:fs/promises';\n"
      + 'export async function cmdFleetWrite() { await writeFile("/tmp/x", "1"); return 0; }';
    expect(inferVerbEffect(source)).toBe('writes');
  });

  it('marks a gh pr close argv as writes', () => {
    const source = 'const result = await run(\'gh\', [\'pr\', \'close\', String(n), \'--repo\', REPO]);';
    expect(inferVerbEffect(source)).toBe('writes');
  });

  it('marks an unreadable source as unknown', () => {
    expect(inferVerbEffect(null)).toBe('unknown');
    expect(buildFleetVerbCatalog(['ghost'], () => null)[0]).toEqual({ verb: 'ghost', usage: null, summary: null, effect: 'unknown' });
  });

  it('keeps the effect field inside the catalog entry for every verb', () => {
    const entries = buildFleetVerbCatalog(
      ['needs-resolve', 'stray-stop', 'landed-sweep', 'merge-pace', 'queue-age'],
      realSource,
    );
    for (const entry of entries) expect(EFFECTS).toContain(entry.effect);
  });

  it('does not mark needs-resolve, stray-stop or landed-sweep as read over the real registry', () => {
    const entries = buildFleetVerbCatalog(['needs-resolve', 'stray-stop', 'landed-sweep'], realSource);
    for (const entry of entries) {
      expect(entry.effect, `${entry.verb} must not classify as read`).not.toBe('read');
    }
    expect(entries.find(e => e.verb === 'stray-stop')?.effect).toBe('apply-gated');
    expect(entries.find(e => e.verb === 'landed-sweep')?.effect).toBe('apply-gated');
  });
});
