/**
 * Recut regression pin — RQ-PHX-RECUTCOREO1C156 (recut of PR #1728).
 *
 * #1728 reverted #688 ("Ashlr MD as the out-of-box Markdown opener") on top of
 * current master: `openInEditor` sends Markdown files to the configured editor
 * like every other path, and the mdopener:// planner helpers are gone from the
 * module surface. These assertions pin that recovered behavior through the
 * real exported entry point, so a re-introduction of the interception fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as openModule from '../src/cli/open.js';
import { editorDeepLink, openInEditor } from '../src/cli/open.js';
import type { AshlrConfig } from '../src/core/types.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

const cfg = { version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [], models: {}, telemetry: {}, tools: {} } as AshlrConfig;

function spawnedArgs(): string[] {
  return spawnMock.mock.calls.flatMap((call) => call[1] as string[]);
}

describe('openInEditor — Markdown goes to the configured editor (recut of #1728)', () => {
  beforeEach(() => {
    spawnMock.mockReset().mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('launches the editor deep link for a Markdown path, never mdopener://', () => {
    openInEditor('/r/My Notes/README.md', cfg);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnedArgs();
    expect(args).toContain(editorDeepLink('/r/My Notes/README.md', 'cursor'));
    expect(args.some((a) => a.startsWith('mdopener://'))).toBe(false);
  });

  it('ignores a leftover "markdownOpener" config key from an old config.json', () => {
    openInEditor('/r/doc.md', { ...cfg, markdownOpener: 'ashlr-md' } as AshlrConfig);
    expect(spawnedArgs()).toContain(editorDeepLink('/r/doc.md', 'cursor'));
  });

  it('honors the vscode editor for Markdown too', () => {
    openInEditor('/r/doc.md', { ...cfg, editor: 'vscode' });
    expect(spawnedArgs()).toContain(editorDeepLink('/r/doc.md', 'vscode'));
  });

  it('no longer exports the Ashlr-MD opener machinery', () => {
    for (const name of [
      'planMarkdownOpen', 'markdownOpenerPref', 'ashlrMdDeepLink',
      'ashlrMdCandidates', 'isAshlrMdInstalled', 'ashlrMdInstallHint', 'isMarkdownPath',
    ]) {
      expect(name in openModule, name).toBe(false);
    }
  });
});
