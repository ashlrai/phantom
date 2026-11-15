/**
 * Preservation pin — RQ-PHX-MDOPENERCOVER185S (preserved from PR #5089, the
 * RQ-PHX-RECUTCOREO1C156 recut of PR #1728).
 *
 * Markdown files opened through `openInEditor` go to the configured editor
 * (Cursor by default, VS Code when `editor: 'vscode'`). An obsolete
 * `markdownOpener` key in an old config.json must not intercept them, and the
 * mdopener:// planner exports must stay absent from the module surface.
 *
 * Exercises the exported entry points only; `node:child_process.spawn` is
 * mocked so no editor is ever launched. Fake fixture paths only.
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

const cfg = {
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [],
  keepers: [], models: {}, telemetry: {}, tools: {},
} as AshlrConfig;

function spawnedArgs(): string[] {
  return spawnMock.mock.calls.flatMap((call) => call[1] as string[]);
}

describe('openInEditor — Markdown goes to the selected editor (preserved from PR #5089)', () => {
  beforeEach(() => {
    spawnMock.mockReset().mockReturnValue({ on: vi.fn(), unref: vi.fn() });
  });

  it('opens a Markdown path in the Cursor editor deep link, never mdopener://', () => {
    openInEditor('/r/My Notes/README.md', cfg);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnedArgs();
    expect(args).toContain(editorDeepLink('/r/My Notes/README.md', 'cursor'));
    expect(args.some((a) => a.startsWith('mdopener://'))).toBe(false);
  });

  it('ignores a leftover "markdownOpener" config key from an old config.json', () => {
    openInEditor('/r/doc.md', { ...cfg, markdownOpener: 'ashlr-md' } as AshlrConfig);
    expect(spawnedArgs()).toContain(editorDeepLink('/r/doc.md', 'cursor'));
    expect(spawnedArgs().some((a) => a.startsWith('mdopener://'))).toBe(false);
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
