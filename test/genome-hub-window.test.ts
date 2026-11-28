/**
 * Genome hub read-window tests — hermetic, tmp HOME.
 *
 * SAFETY GUARDRAIL: process.env.HOME is overridden to a tmp dir per test.
 * Never touches real ~/.ashlr.
 *
 * The hub store (~/.ashlr/genome/hub.jsonl) is append-only and chronological.
 * loadGenome keeps a bounded window of HUB_MAX_ENTRIES (2000) valid records;
 * that window must come from the END of the file. A head-first cap froze
 * recall, playbook synthesis, export and capture dedupe on the oldest records
 * once the log outgrew the cap — the live store passed 16k entries, so only
 * the first week's memories were ever loaded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, GenomeEntry } from '../src/core/types.js';

const origHome = process.env.HOME;
let tmpHome: string;

let loadGenome: (cfg: AshlrConfig) => GenomeEntry[];

async function ensureImported(): Promise<void> {
  if (!loadGenome) {
    const mod = await import('../src/core/genome/store.js');
    loadGenome = mod.loadGenome;
  }
}

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

function hubPath(): string {
  return path.join(tmpHome, '.ashlr', 'genome', 'hub.jsonl');
}

function hubEntry(i: number): string {
  return JSON.stringify({
    id: `e${String(i).padStart(5, '0')}`,
    project: null,
    source: 'hub',
    title: `memory ${i}`,
    text: `bounded window fixture entry ${i}`,
    tags: [],
    ts: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
  });
}

/** Write raw lines (valid entries and anything else) to hub.jsonl. */
function writeHubLines(lines: string[]): void {
  const dir = path.join(tmpHome, '.ashlr', 'genome');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(hubPath(), lines.join('\n') + '\n');
}

function writeHubEntries(count: number, offset = 0): void {
  writeHubLines(Array.from({ length: count }, (_, i) => hubEntry(offset + i)));
}

function hubIds(): string[] {
  return loadGenome(makeConfig())
    .filter((e) => e.source === 'hub')
    .map((e) => e.id);
}

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-genome-window-'));
  process.env.HOME = tmpHome;
  await ensureImported();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

describe('loadGenome hub read window', () => {
  it('returns every entry while the store is under the cap, in file order', () => {
    writeHubEntries(3);
    expect(hubIds()).toEqual(['e00000', 'e00001', 'e00002']);
  });

  it('keeps the NEWEST 2000 entries once the store outgrows the cap', () => {
    writeHubEntries(2005);
    const ids = hubIds();
    expect(ids).toHaveLength(2000);
    // The five oldest records fall out of the window; the newest survive.
    expect(ids[0]).toBe('e00005');
    expect(ids[1999]).toBe('e02004');
    expect(ids).not.toContain('e00000');
    expect(ids).not.toContain('e00004');
  });

  it('preserves append order inside the kept window', () => {
    writeHubEntries(2005);
    const ids = hubIds();
    const ts = loadGenome(makeConfig())
      .filter((e) => e.source === 'hub')
      .map((e) => e.ts);
    expect([...ts].sort()).toEqual(ts);
    expect(ids).toEqual([...ids].sort());
  });

  it('skips malformed lines without spending cap slots', () => {
    const lines: string[] = [];
    for (let i = 0; i < 2003; i++) lines.push(hubEntry(i));
    // Junk at the tail: reverse scan steps over it and still reaches the
    // newest valid entries instead of truncating the window early.
    lines.push('not json at all', '{"broken":', '');
    writeHubLines(lines);
    const ids = hubIds();
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe('e00003');
    expect(ids[1999]).toBe('e02002');
  });

  it('skips valid JSON missing required fields without spending cap slots', () => {
    const lines: string[] = [];
    for (let i = 0; i < 2002; i++) lines.push(hubEntry(i));
    lines.push(JSON.stringify({ id: 'no-text', title: 't', ts: 'x' }));
    lines.push(JSON.stringify({ id: 'no-ts', title: 't', text: 'x' }));
    writeHubLines(lines);
    const ids = hubIds();
    expect(ids).toHaveLength(2000);
    expect(ids).not.toContain('no-text');
    expect(ids).not.toContain('no-ts');
    expect(ids[0]).toBe('e00002');
    expect(ids[1999]).toBe('e02001');
  });

  it('appends after the cap stay visible — the window follows the tail', () => {
    writeHubEntries(2001);
    const before = hubIds();
    expect(before[0]).toBe('e00001');
    // One more append: oldest drops out, newest enters.
    fs.appendFileSync(hubPath(), hubEntry(2001) + '\n');
    const after = hubIds();
    expect(after).toHaveLength(2000);
    expect(after[0]).toBe('e00002');
    expect(after[1999]).toBe('e02001');
  });
});
