/**
 * A genome note with no text is refused, not stored.
 *
 * `phm learn ""` already exits 2 with usage, but the `ashlr_learn` MCP tool
 * passed whitespace-only text straight to appendHubEntry, which wrote an empty
 * "Note" entry to hub.jsonl and answered `{ stored: true }`. The store now
 * refuses blank text, so the MCP call is an isError result and nothing is
 * written.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { appendHubEntry, hubStorePath } from '../src/core/genome/store.js';
import { callNativeTool } from '../src/core/mcp-native.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function hubLines(): string[] {
  const path = join(fx.ashlrDir, 'genome', 'hub.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

describe('blank genome notes', () => {
  it.each(['', '   ', '\n\t\n'])('appendHubEntry refuses %j and writes nothing', (text) => {
    expect(() => appendHubEntry({ text, hubOnly: true })).toThrow(/note text is empty/);
    expect(existsSync(hubStorePath())).toBe(false);
  });

  it('ashlr_learn over MCP refuses whitespace-only text as an error', async () => {
    const r = await callNativeTool('ashlr_learn', { text: '   ' });
    expect(r.isError).toBe(true);
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/note text is empty/);
    expect(text).not.toMatch(/"stored": true/);
    expect(hubLines()).toEqual([]);
  });

  it('a real note is still stored', async () => {
    const r = await callNativeTool('ashlr_learn', { text: 'prefer small PRs' });
    expect(r.isError).toBeUndefined();
    expect(hubLines()).toHaveLength(1);
  });
});
