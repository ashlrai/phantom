/**
 * The measuring half of `phm mobile check` (core/mobile/check.ts holds the
 * report). jsdom has no layout, so each rendered element is matched against
 * the stylesheet rules that apply to it at 390 px: global.css plus the CSS
 * module each class came from (the test renderer names a class
 * `_name_<sha1 of the file path, 6 chars>`, so the file is known exactly).
 * Later rules win; specificity and inherited `white-space` are not modelled.
 * A size no rule states is counted as unknown.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { MAX_FINDINGS, MIN_TAP_PX, MIN_TEXT_PX, MOBILE_WIDTH_PX, type MobileFinding, type MobileViewCheck } from '../../../../core/mobile/check.js';
import { declsForAt, lightScope, resolveValue } from '../../../design/token-probe.test-support.js';
import { VIEWPORT_QUERIES } from '../shell/viewport.js';
import { evaluateMediaQuery } from '../shell/viewport.test-support.js';

export interface CssRule { selector: string; decls: Array<[string, string]> }
/** Rules by the class hash of the file they came from; '' holds rules that apply to every element. */
export type Sheets = Map<string, CssRule[]>;

/** The rules live at `width`. With `hash`, `.name` becomes the class the test renderer gives that file. */
export function parseCss(css: string, hash = '', width = MOBILE_WIDTH_PX): CssRule[] {
  const rules: CssRule[] = [], open: string[] = [];
  let text = '';
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') { open.push(text.trim()); text = ''; continue; }
    if (ch !== '}') { text += ch; continue; }
    const selector = open.pop() ?? '';
    const live = open.every(at => !at.startsWith('@media') || evaluateMediaQuery(at.slice(6), width));
    if (live && selector && !selector.startsWith('@')) rules.push({
      selector: hash ? selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, `._$1_${hash}`) : selector,
      decls: text.split(';').map(decl => decl.split(/:(.*)/s)).filter(parts => parts.length > 1).map(parts => [parts[0]!.trim(), parts[1]!.replace('!important', '').trim()]),
    });
    text = '';
  }
  return rules;
}

let webUi: Sheets | null = null;
export function webUiSheets(root = process.cwd()): Sheets {
  if (webUi) return webUi;
  const web = resolve(root, 'src/web-ui');
  webUi = new Map([['', parseCss(readFileSync(join(web, 'design/global.css'), 'utf8'))]]);
  for (const file of (readdirSync(web, { recursive: true }) as string[]).filter(name => name.endsWith('.module.css'))) {
    const hash = createHash('sha1').update(relative(root, join(web, file))).digest('hex').slice(0, 6);
    webUi.set(hash, parseCss(readFileSync(join(web, file), 'utf8'), hash));
  }
  return webUi;
}

// The light tokens, with the phone-width overrides tokens.css declares on top.
const tokens = new Map([...lightScope(), ...declsForAt(VIEWPORT_QUERIES.compact, ':root')]);
const resolved = (value: string | undefined): string => value ? resolveValue(tokens, value) ?? value : '';
function px(value: string | undefined, em = 16): number | null {
  const match = /^([\d.]+)(px|rem|em)$/.exec(resolved(value));
  const size = match ? Number(match[1]) * (match[2] === 'px' ? 1 : match[2] === 'rem' ? 16 : em) : NaN;
  return Number.isNaN(size) ? null : Math.round(size * 10) / 10;
}
const TAPPABLE = 'button, a[href], select, textarea, summary, input:not([type="hidden"]), [role="button"], [role="tab"], [role="link"], [role="menuitem"]';
const ownText = (el: Element): boolean => [...el.childNodes].some(node => node.nodeType === 3 && node.textContent?.trim());
const name = (el: Element): string => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;

export function checkView(id: string, title: string, root: Element, sheets: Sheets = webUiSheets(), width = MOBILE_WIDTH_PX): MobileViewCheck {
  const styles = new WeakMap<Element, Map<string, string>>();
  const findings: MobileFinding[] = [];
  let unknown = 0;
  const add = (kind: MobileFinding['kind'], el: Element, detail: string) => findings.push({ kind, element: name(el), detail });

  function style(el: Element): Map<string, string> {
    let known = styles.get(el);
    if (known) return known;
    styles.set(el, known = new Map());
    const hashes = new Set(['']);
    for (let node: Element | null = el; node; node = node.parentElement) for (const match of (node.getAttribute('class') ?? '').matchAll(/_([0-9a-f]{6})(?=\s|$)/g)) hashes.add(match[1]!);
    for (const hash of hashes) for (const rule of sheets.get(hash) ?? []) {
      let hit = false;
      try { hit = el.matches(rule.selector); } catch { /* a selector jsdom cannot parse applies to nothing here */ }
      if (hit) for (const [prop, value] of rule.decls) known.set(prop, value);
    }
    const inline = (el as HTMLElement).style;
    for (let i = 0; i < (inline?.length ?? 0); i++) known.set(inline[i]!, inline.getPropertyValue(inline[i]!));
    return known;
  }
  /** Null when a size in the chain is not a plain length (clamp(), a keyword). */
  function fontPx(el: Element | null): number | null {
    if (!el) return 16;
    const own = style(el).get('font-size'), parent = fontPx(el.parentElement);
    return own === undefined || own === 'inherit' ? parent : px(own, parent ?? NaN);
  }
  const overflow = (el: Element): string => `${style(el).get('overflow-x') ?? ''} ${style(el).get('overflow') ?? ''}`;
  /** True when this box or one around it scrolls sideways, so nothing wider reaches the page. */
  function scrolls(el: Element | null): boolean {
    for (let node = el; node && root.contains(node); node = node.parentElement) if (/auto|scroll/.test(overflow(node))) return true;
    return false;
  }

  for (const el of root.querySelectorAll('*')) {
    if (el.closest('svg, [hidden]')) continue;
    const css = style(el), font = fontPx(el);
    const wide = (['width', 'min-width'] as const).map(prop => [prop, px(css.get(prop), font ?? 16)] as const).find(([, size]) => size !== null && size > width);
    const columns = [...resolved(css.get('grid-template-columns')).matchAll(/([\d.]+)px/g)].reduce((total, match) => total + Number(match[1]), 0);
    const line = Math.max(...(el.textContent ?? '').split('\n').map(part => part.trim().length));
    if (wide && !scrolls(el.parentElement)) add('overflow', el, `${wide[0]} ${wide[1]}px`);
    else if (columns > width && !scrolls(el)) add('overflow', el, `grid columns add up to ${columns}px`);
    // About half an em per character: one unbroken line this long cannot fit.
    else if (/^(nowrap|pre)$/.test(css.get('white-space') ?? '') && line * (font ?? 14) * 0.5 > width && !scrolls(el) && !/hidden|clip/.test(overflow(el))) add('overflow', el, `one unbroken line of ${line} characters`);

    // A link inside a sentence is read, not aimed at; every other control needs a thumb-sized box.
    if (el.matches(TAPPABLE) && !(el.tagName === 'A' && el.parentElement && ownText(el.parentElement))) {
      const pad = resolved(css.get('padding-block') ?? css.get('padding')).split(/\s+/);
      const lineHeight = css.get('line-height');
      const text = px(lineHeight, font ?? NaN) ?? (font === null ? null : font * (Number(lineHeight) || 1.4));
      const stated = px(css.get('min-height'), font ?? 16) ?? px(css.get('height'), font ?? 16);
      const top = px(pad[0], font ?? 16), bottom = px(pad[pad.length > 2 ? 2 : 0], font ?? 16);
      // No stated height: the box is its line of text plus its padding, when both are known.
      const height = stated ?? (text !== null && top !== null && bottom !== null ? Math.round(text + top + bottom) : null);
      if (height === null) unknown += 1;
      else if (height < MIN_TAP_PX) add('tap', el, `${stated === null ? 'about ' : ''}${height}px tall`);
    }
    if (ownText(el)) {
      if (font === null) unknown += 1;
      else if (font < MIN_TEXT_PX) add('text', el, `${font}px`);
    }
  }
  const count = (kind: MobileFinding['kind']) => findings.filter(finding => finding.kind === kind).length;
  return { id, title, rendered: true, overflow: count('overflow'), smallTaps: count('tap'), smallText: count('text'), unknown, findings: findings.slice(0, MAX_FINDINGS) };
}
