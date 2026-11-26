/**
 * app/self-surface-client.ts — the desktop webview's half of the self-surface
 * (core/verse/self-surface.ts): long-poll for an agent's request, run it in
 * the page, post the result. Runs only where the console mutation token is
 * held (the desktop app), loads after first paint, and never reads input
 * values: a snapshot carries roles, names and stable ids only.
 */
import { apiGet, apiPost } from '../data/client.js';
import { getMutationToken } from '../data/auth-store.js';
import { getVerseUiState, setVerseSection, VERSE_SECTIONS, type VerseSectionId } from '../routes/verse/verse-ui-store.js';

type Request =
  | { verb: 'snapshot' }
  | { verb: 'screenshot'; includeImage?: boolean }
  | { verb: 'navigate'; section: string; anchor?: string }
  | { verb: 'act'; testId: string; action: 'click' | 'focus' };
interface Command { id: string; request: Request; issuedAt: number }
type Outcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

const ID_ATTRS = ['data-testid', 'data-section', 'data-verse-anchor', 'data-settings-group'] as const;
const NODE_SELECTOR = `${ID_ATTRS.map((a) => `[${a}]`).join(',')},button,a[href],[role],h1,h2,h3,input,select,textarea,main,nav,[aria-label]`;
const MAX_NODES = 400;
const SETTLE_QUIET_MS = 250;
const SETTLE_CAP_MS = 6_000;

const errors: string[] = [];
function noteError(text: string): void {
  errors.push(text.slice(0, 200));
  if (errors.length > 20) errors.shift();
}

function stableId(el: Element): string | null {
  for (const attr of ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value) return value;
  }
  return null;
}

function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label) return label.slice(0, 80);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return (el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '').slice(0, 80);
  }
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function snapshotPage(doc: Document = document): Record<string, unknown> {
  const nodes = [...doc.querySelectorAll(NODE_SELECTOR)].slice(0, MAX_NODES).map((el) => ({
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    name: nameOf(el),
    id: stableId(el),
    ...(el instanceof HTMLInputElement ? { type: el.type } : {}),
    ...(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
    ...(el.getAttribute('aria-current') ? { current: true } : {}),
  }));
  const root = doc.documentElement;
  return {
    route: { section: getVerseUiState().section, path: location.pathname, hash: location.hash },
    title: doc.title,
    viewport: { width: innerWidth, height: innerHeight },
    scrollHeight: root.scrollHeight,
    overflowX: root.scrollWidth > innerWidth + 1,
    nodeCount: doc.getElementsByTagName('*').length,
    consoleErrors: [...errors],
    nodes,
  };
}

const LOADING_SELECTOR = '.skeleton,[aria-busy="true"]';

/** A skeleton or busy region on screen; kept-alive hidden sections do not count. */
function visiblyLoading(): boolean {
  return [...document.querySelectorAll(LOADING_SELECTOR)].some((el) => el.getClientRects().length > 0);
}

/** Resolves once the DOM has been quiet for SETTLE_QUIET_MS with no skeleton or busy region left (capped at SETTLE_CAP_MS). */
function settle(): Promise<{ ms: number; stillLoading: boolean }> {
  const start = performance.now();
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const finish = () => {
      observer.disconnect(); clearTimeout(quiet); clearTimeout(cap);
      resolve({ ms: Math.round(performance.now() - start), stillLoading: visiblyLoading() });
    };
    const quietDone = () => { if (visiblyLoading()) quiet = setTimeout(quietDone, SETTLE_QUIET_MS); else finish(); };
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(quietDone, SETTLE_QUIET_MS); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    quiet = setTimeout(quietDone, SETTLE_QUIET_MS);
    const cap = setTimeout(finish, SETTLE_CAP_MS);
  });
}

function findTarget(id: string, doc: Document = document): Element | null {
  const escaped = CSS.escape(id);
  for (const attr of ID_ATTRS) {
    const hit = doc.querySelector(`[${attr}="${escaped}"]`);
    if (hit) return hit;
  }
  return doc.querySelector(`button[aria-label="${escaped}"],a[aria-label="${escaped}"]`);
}

const IMAGE_INLINE_TIMEOUT_MS = 2_000;
const IMAGE_INLINE_MAX_BYTES = 2 * 1024 * 1024;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/** An image the SVG snapshot can draw: same bytes, as a data: URL, or null when unreachable. */
async function imageDataUrl(img: HTMLImageElement, fetcher: typeof fetch): Promise<string | null> {
  const src = img.currentSrc || img.src;
  if (!src || src.startsWith('data:')) return src || null;
  try { await img.decode(); } catch { /* still try the bytes below */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_INLINE_TIMEOUT_MS);
  try {
    const response = await fetcher(src, { signal: controller.signal, credentials: 'same-origin' });
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size <= IMAGE_INLINE_MAX_BYTES && blob.type.startsWith('image/')) return await blobToDataUrl(blob);
    }
  } catch { /* fall through to the decoded pixels */ } finally { clearTimeout(timer); }
  if (!img.complete || img.naturalWidth === 0) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch { return null; }
}

/**
 * An SVG foreignObject is rendered as an isolated image, so it never loads
 * the page's <img> URLs (asset logos, uploads, external icons). Copy each one
 * into the clone as a data: URL so captures show what the page shows.
 */
export async function inlineImages(live: ParentNode, clone: ParentNode, fetcher: typeof fetch = fetch): Promise<number> {
  const sources = [...live.querySelectorAll('img')];
  const targets = [...clone.querySelectorAll('img')];
  if (sources.length !== targets.length) return 0;
  const urls = await Promise.all(sources.map((img) => imageDataUrl(img, fetcher)));
  let inlined = 0;
  urls.forEach((url, i) => {
    const target = targets[i]!;
    target.removeAttribute('srcset');
    target.removeAttribute('loading');
    if (url) { target.setAttribute('src', url); inlined++; } else target.removeAttribute('src');
  });
  return inlined;
}

async function renderPng(): Promise<{ base64: string; width: number; height: number }> {
  const width = innerWidth, height = innerHeight;
  const css = [...document.styleSheets].map((sheet) => {
    try { return [...sheet.cssRules].map((rule) => rule.cssText).join('\n'); } catch { return ''; }
  }).join('\n').replace(/:root\b/g, 'html');
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script,style,link[rel="stylesheet"]').forEach((n) => n.remove());
  await inlineImages(document.documentElement, clone);
  clone.querySelectorAll('input,textarea').forEach((n) => { n.removeAttribute('value'); if (n.tagName === 'TEXTAREA') n.textContent = ''; });
  const head = clone.querySelector('head');
  const style = document.createElement('style');
  style.textContent = css;
  head?.appendChild(style);
  const markup = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="${-scrollY}" width="${width}" height="${document.documentElement.scrollHeight}">${markup}</foreignObject></svg>`;
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('The page could not be rendered.')); });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * devicePixelRatio);
  canvas.height = Math.round(height * devicePixelRatio);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context.');
  context.scale(devicePixelRatio, devicePixelRatio);
  context.drawImage(image, 0, 0);
  return { base64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), width: canvas.width, height: canvas.height };
}

export async function runSelfRequest(request: Request): Promise<Outcome> {
  try {
    switch (request.verb) {
      case 'snapshot':
        return { ok: true, data: snapshotPage() };
      case 'screenshot':
        return { ok: true, data: { ...(await renderPng()), route: { section: getVerseUiState().section } } };
      case 'navigate': {
        if (!VERSE_SECTIONS.some((s) => s.id === request.section)) return { ok: false, error: `Unknown section ${request.section}.` };
        const before = errors.length;
        const settled = settle();
        setVerseSection(request.section as VerseSectionId, request.anchor ?? null);
        const { ms: loadMs, stillLoading } = await settled;
        return { ok: true, data: { section: getVerseUiState().section, loadMs, stillLoading, consoleErrors: errors.slice(before) } };
      }
      case 'act': {
        const target = findTarget(request.testId);
        if (!target) return { ok: false, error: `No element has the stable id ${request.testId}.` };
        if (target instanceof HTMLInputElement && target.type === 'password') return { ok: false, error: 'Password fields are closed to the self-surface.' };
        if (!(target instanceof HTMLElement)) return { ok: false, error: 'That element cannot be driven.' };
        const settled = settle();
        if (request.action === 'focus') target.focus(); else target.click();
        return { ok: true, data: { testId: request.testId, action: request.action, tag: target.tagName.toLowerCase(), name: nameOf(target), settleMs: (await settled).ms } };
      }
      default:
        return { ok: false, error: 'Unknown verb.' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The window could not run that.' };
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start the poll loop; returns its stop. */
export function startSelfSurface(): () => void {
  let live = true;
  const controller = new AbortController();
  const onError = (event: ErrorEvent) => noteError(event.message || 'error');
  const onRejection = (event: PromiseRejectionEvent) => noteError(String(event.reason instanceof Error ? event.reason.message : event.reason));
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  const original = console.error;
  console.error = (...args: unknown[]) => { noteError(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); original.apply(console, args); };
  void (async () => {
    while (live) {
      const token = getMutationToken();
      if (!token) { await sleep(15_000); continue; }
      try {
        const { command } = await apiGet<{ command: Command | null }>('/api/verse/self/next?wait=25000', controller.signal);
        if (!command || !live) continue;
        const result = await runSelfRequest(command.request);
        await apiPost('/api/verse/self/result', { id: command.id, result }, token, controller.signal);
      } catch {
        if (live) await sleep(5_000);
      }
    }
  })();
  return () => {
    live = false;
    controller.abort();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    console.error = original;
  };
}
