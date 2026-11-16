/**
 * visible-text.ts: rendered HTML to the text a person would see. The browser
 * readers parse this text only: never attributes, scripts, JSON blobs, cookies
 * or storage. Hidden subtrees (hidden, aria-hidden, display:none) are dropped
 * with real depth tracking, so nested same-name tags do not leak text.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript', 'template', 'head', 'svg']);
const BLOCK = new Set([
  'address', 'article', 'button', 'td', 'th', 'label', 'option', 'summary', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tr', 'ul',
]);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const hiddenAttrs = (attrs: string): boolean =>
  /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) ||
  /aria-hidden\s*=\s*["']?true/i.test(attrs) ||
  /style\s*=\s*["'][^"']*display\s*:\s*none/i.test(attrs);

const TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</g;

/** Visible text of an HTML document, one trimmed non-empty line per block. */
export function htmlToVisibleText(html: string): string {
  const stack: Array<{ tag: string; hidden: boolean }> = [];
  let out = '';
  let hidden = false;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html)) !== null) {
    const [whole, closing, rawTag, attrs = ''] = m;
    if (whole.startsWith('<!') || whole.startsWith('<?')) continue;
    if (rawTag === undefined) {
      if (!hidden) out += whole;
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) stack.length = at;
      hidden = stack.some((s) => s.hidden);
      if (!hidden && BLOCK.has(tag)) out += '\n';
      continue;
    }
    if (!hidden && BLOCK.has(tag)) out += '\n';
    if (VOID.has(tag) || attrs.trimEnd().endsWith('/')) continue;
    if (RAW.has(tag)) {
      // Skip the raw body wholesale: script text may contain a literal '<'.
      const end = html.toLowerCase().indexOf(`</${tag}`, TOKEN.lastIndex);
      if (end < 0) break;
      TOKEN.lastIndex = end;
      continue;
    }
    stack.push({ tag, hidden: hiddenAttrs(attrs) });
    hidden = hidden || stack[stack.length - 1].hidden;
  }
  return decode(out)
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
