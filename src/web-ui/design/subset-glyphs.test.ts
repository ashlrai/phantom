/**
 * Guard the font budget using both ranges declared in global.css. The full
 * face now has a unicode-range, so symbols outside both faces use a system
 * fallback instead of downloading it. Composer and Command remain subset-only.
 * KNOWN tracks historical exceptions and cannot admit a new full-face glyph.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(process.cwd(), 'src/web-ui');

/** Read the actual unicode-range from the matching font face. */
function fontRanges(fontFile: string): Array<[number, number]> {
  const css = readFileSync(join(WEB, 'design/global.css'), 'utf8');
  const face = css.match(/@font-face\s*\{[^}]*IBMPlexSans-full\.woff2[^}]*\}|@font-face\s*\{[^}]*AshlrSans-latin\.woff2[^}]*\}/gs)?.find((block) => block.includes(fontFile));
  const m = face && /unicode-range:\s*([^;]+);/s.exec(face);
  if (!m) throw new Error(`global.css: no unicode-range on ${fontFile}`);
  return m[1]!.split(',').map((part) => {
    const [a, b] = part.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
  });
}

/** Code outside comments: block comments, whole-line // comments and trailing " // …" comments go. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/[^\n'"`]*$/gm, '');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.|test-support/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Other units' files that still draw out-of-subset glyphs as text (CROSS-UNIT
 * REQUEST from F6: move them to SVG, or give the full face its own
 * unicode-range in global.css so a glyph Plex lacks never fetches it).
 */
const KNOWN: Record<string, string> = {
  'routes/verse/SeatCapacity.tsx': '▮◑',
  'routes/verse/Workspace.tsx': '◔',
  'routes/verse/Sidebar.tsx': '▮',
  'routes/verse/chat/ChapterRail.tsx': '↺◆⤷',
  'routes/verse/shell/CommandPalette.tsx': '↩⇥',
  'routes/verse/shell/NeedsYouDrawer.tsx': '↩',
  'routes/verse/shell/command-catalog.ts': '▸',
  'routes/verse/shell/command-keys.ts': '↩⇥⌃⌫',
  'routes/verse/autonomy/ScopePanel.tsx': '⚠',
  'routes/verse/mind/MindCards.tsx': '✗',
  'routes/verse/dock/terminal/TerminalPane.tsx': '⌃',
  'routes/verse/autonomy/autonomy.module.css': '⊘',
};

describe('Phantom UI text stays inside the Ashlr Sans subset', () => {
  const ranges = fontRanges('AshlrSans-latin.woff2');
  const fullRanges = fontRanges('IBMPlexSans-full.woff2');
  const inSubset = (cp: number) => cp < 0x80 || ranges.some(([a, b]) => cp >= a && cp <= b);

  it('parses the subset range from global.css', () => {
    expect(ranges.length).toBeGreaterThan(10);
    expect(inSubset('→'.codePointAt(0)!)).toBe(true);
    expect(inSubset('◇'.codePointAt(0)!)).toBe(false);
    expect(fullRanges.some(([a, b]) => '▸'.codePointAt(0)! >= a && '▸'.codePointAt(0)! <= b)).toBe(false);
    expect(fullRanges.some(([a, b]) => 'Ω'.codePointAt(0)! >= a && 'Ω'.codePointAt(0)! <= b)).toBe(true);
  });

  it('no file gains a character that would fetch the 230 KB full face', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(WEB, 'routes/verse')), ...sourceFiles(join(WEB, 'app'))]) {
      const rel = relative(WEB, file).split('\\').join('/');
      const allowed = KNOWN[rel] ?? '';
      const bad = new Set<string>();
      for (const ch of stripComments(readFileSync(file, 'utf8'))) {
        const cp = ch.codePointAt(0)!;
        if (!inSubset(cp) && fullRanges.some(([a, b]) => cp >= a && cp <= b) && !allowed.includes(ch)) bad.add(`${ch} U+${cp.toString(16).toUpperCase().padStart(4, '0')}`);
      }
      if (bad.size) offenders.push(`${rel}: ${[...bad].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the Composer and Command surfaces carry none at all', () => {
    for (const rel of ['routes/verse/Composer.tsx', 'routes/verse/command/SeatBurnDowns.tsx', 'routes/verse/command/SeatStrip.tsx', 'routes/verse/command/seat-strip-model.ts']) {
      const text = stripComments(readFileSync(join(WEB, rel), 'utf8'));
      const outside = [...text].filter((ch) => !inSubset(ch.codePointAt(0)!));
      expect(outside, rel).toEqual([]);
    }
  });
});
