import { describe, it, expect } from 'vitest';
import {
  ashlrMdDeepLink, ashlrMdInstallHint, isAshlrMdInstalled, isMarkdownPath,
  markdownOpenerPref, planMarkdownOpen,
} from '../src/core/markdown-opener.js';

const none = { platform: 'darwin' as const, env: { PATH: '/usr/bin' }, home: '/Users/m', exists: () => false };
const app = { ...none, exists: (p: string) => p === '/Applications/Ashlr MD.app' };

describe('markdown opener (Ashlr MD)', () => {
  it('detects markdown extensions', () => {
    expect(isMarkdownPath('/a/README.md')).toBe(true);
    expect(isMarkdownPath('/a/notes.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('/a/x.mdx')).toBe(true);
    expect(isMarkdownPath('/a/x.ts')).toBe(false);
    expect(isMarkdownPath('/a/md')).toBe(false);
  });

  it('defaults to ashlr-md; only "editor" opts out', () => {
    expect(markdownOpenerPref({})).toBe('ashlr-md');
    expect(markdownOpenerPref({ markdownOpener: 'bogus' })).toBe('ashlr-md');
    expect(markdownOpenerPref({ markdownOpener: 'editor' })).toBe('editor');
  });

  it('builds an encoded mdopener:// deep link', () => {
    expect(ashlrMdDeepLink('/Users/m/My Notes/a&b.md'))
      .toBe('mdopener://open?path=%2FUsers%2Fm%2FMy%20Notes%2Fa%26b.md');
    expect(ashlrMdDeepLink('/x.md', 'edit')).toBe('mdopener://open?path=%2Fx.md&mode=edit');
  });

  it('detects the app bundle, the mdopen CLI, and honours env override', () => {
    expect(isAshlrMdInstalled(none)).toBe(false);
    expect(isAshlrMdInstalled(app)).toBe(true);
    expect(isAshlrMdInstalled({ ...none, platform: 'linux', exists: (p) => p === '/usr/bin/mdopen' })).toBe(true);
    expect(isAshlrMdInstalled({ ...app, env: { PHANTOM_ASHLR_MD: '0' } })).toBe(false);
    expect(isAshlrMdInstalled({ ...none, env: { PHANTOM_ASHLR_MD: '1' } })).toBe(true);
  });

  it('plans open with graceful fallback', () => {
    expect(planMarkdownOpen('/r/README.md', {}, app)).toEqual({ kind: 'ashlr-md', url: 'mdopener://open?path=%2Fr%2FREADME.md' });
    expect(planMarkdownOpen('/r/README.md', {}, none)).toEqual({ kind: 'fallback', reason: 'not-installed' });
    expect(planMarkdownOpen('/r/README.md', { markdownOpener: 'editor' }, app)).toEqual({ kind: 'fallback', reason: 'opted-out' });
    expect(planMarkdownOpen('/r/index.ts', {}, app)).toEqual({ kind: 'fallback', reason: 'not-markdown' });
  });

  it('install hint points at releases and the opt-out', () => {
    const h = ashlrMdInstallHint('darwin');
    expect(h).toContain('github.com/ashlrai/ashlr-md/releases');
    expect(h).toContain('"markdownOpener": "editor"');
  });
});
