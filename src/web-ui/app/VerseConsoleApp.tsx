/**
 * app/VerseConsoleApp.tsx — isolated bootstrap for /verse (pattern:
 * ResourcePoolConsoleApp). No global dashboard shell, router, or observer
 * stream: the read session is probed against /api/verse/bootstrap, host-
 * injected tokens (desktop wrapper) are adopted before that probe, and the
 * full-bleed VerseApp takes over once authenticated.
 *
 * V3.10 — first paint without a serial wait. The chunk of the section the
 * shell will mount (Chat, unless the operator left another one open) used to
 * start downloading only AFTER the bootstrap probe answered: index →
 * this module → probe → section chunk, one round trip after another. Now
 * the import starts the moment this module evaluates (through
 * app/verse-first-paint.ts since 3.29.16), in parallel with the probe, and
 * this module preloads the Latin font subsets the first paint needs (the
 * display face only once the signed-in app is what will paint).
 *
 * V3.10 — a restarted desktop sidecar is re-adopted at once. The desktop
 * shell restarts a crashed server in the background, hands the new tokens to
 * this page as `window.__ASHLR_TOKENS__` and fires `ashlr:sidecar-restarted`
 * (desktop/src-tauri/src/main.rs token_handoff_script). The old cookie died
 * with the old server, so without listening the page would sit until its
 * next 401 → failed renewal → SessionGate → adoption.
 */
import { PRODUCT_NAME } from './product-brand.js';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ToastProvider } from '../components/primitives/Toast.js';
import { adoptInjectedTokens, markCheckComplete } from '../data/auth-store.js';
import { getQuerySnapshot, runQuery } from '../data/cache.js';
import { useAuthPhase } from '../data/hooks.js';
import { VerseApp } from '../routes/verse/VerseApp.js';
import { verseBootstrapQuery } from '../routes/verse/verse-queries.js';
import uiFontLatin from '../design/fonts/AshlrSans-latin.woff2?url';
import displayFontLatin from '../design/fonts/SpaceGrotesk-latin.woff2?url';
import { SkipToContent } from './SkipToContent.js';
import styles from './VerseConsoleApp.module.css';
import '../design/global.css';

/**
 * Preload the Latin font subsets: the UI face always (every state's first
 * text is set in it), the display face (Space Grotesk: headings, numerals)
 * only when the signed-in app is what will paint. On the signed-out connect
 * screen the display face serves one heading, drawn only after the auth probe
 * answers and the gate's chunk arrives; preloaded at page start it routinely
 * sat unused past the browser's few-second window and drew "preloaded but
 * not used" in the console. Idempotent.
 */
export function preloadVerseFonts(doc: Document | null, display: boolean): void {
  if (!doc?.head) return;
  for (const href of display ? [uiFontLatin, displayFontLatin] : [uiFontLatin]) {
    const present = [...doc.head.querySelectorAll('link[rel="preload"]')].some((l) => l.getAttribute('href') === href);
    if (present) continue;
    const link = doc.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/woff2';
    // Font preloads are CORS requests even same-origin; without this the
    // browser fetches the file twice.
    link.crossOrigin = 'anonymous';
    link.href = href;
    doc.head.append(link);
  }
}

/**
 * Start what the first paint will need, without waiting for the auth probe.
 * Everything here is a cache warm-up: a failure is ignored, because the real
 * mount (VerseApp's sectionLoader, the CSS @font-face) repeats the request
 * and owns the error handling.
 *
 * `signedIn` is the best guess available before the probe: the desktop shell
 * injected its tokens, so the chat is what paints. Otherwise the display face
 * waits for the authenticated phase (VerseConsoleApp below).
 */
export function preloadVerseFirstPaint(
  doc: Document | null = typeof document === 'undefined' ? null : document,
  signedIn: boolean = typeof window !== 'undefined' && window.__ASHLR_TOKENS__ !== undefined,
): void {
  // The opening section's chunk starts in app/verse-first-paint.ts, imported below.
  preloadVerseFonts(doc, signedIn);
}

preloadVerseFirstPaint();

/**
 * Resolves once the shell's first-paint chunks are in (or a bounded wait ran
 * out; app/verse-first-paint.ts). The signed-in shell mounts after it, so it
 * paints whole instead of committing skeletons that React then holds for its
 * 300 ms Suspense reveal throttle. The wait itself is a chunk of its own: it
 * runs alongside first paint, never costs it bytes.
 */
const firstPaintSurface: Promise<void> = typeof window === 'undefined'
  ? Promise.resolve()
  : import('./verse-first-paint.js').then((m) => m.firstPaintSurface(), () => undefined);

/**
 * The session gate is a dynamic import: a signed-in cold load (the common
 * case — the desktop shell injects its tokens) never draws it, and as a
 * static import it cost ~3 KB of chat first-paint critical JS (SPEC-310A §1).
 * `preloadSessionGate` starts the download while the auth probe is in flight,
 * so an unauthenticated answer finds the chunk already there instead of
 * paying a second round trip. Vite shares the in-flight import with lazy().
 */
const importSessionGate = () => import('../components/auth/SessionGate.js');
const SessionGate = lazy(() => importSessionGate().then((m) => ({ default: m.SessionGate })));
function preloadSessionGate(): void {
  void importSessionGate().catch(() => undefined);
}

export function VerseConsoleApp() {
  const phase = useAuthPhase();
  const [surface, setSurface] = useState(false);
  useEffect(() => {
    let live = true;
    let off: (() => void) | undefined;
    void firstPaintSurface.then(() => { if (live) setSurface(true); });
    // app/sidecar-restart.ts: a chunk of its own, off the first-paint path.
    void import('./sidecar-restart.js').then((m) => { if (live) off = m.listenForSidecarRestart(); }, () => undefined);
    return () => { live = false; off?.(); };
  }, []);
  useEffect(() => {
    if (phase === 'authenticated') preloadVerseFonts(document, true);
    if (phase !== 'checking') return;
    preloadSessionGate();
    let cancelled = false;
    void adoptInjectedTokens().then((adopted) => {
      if (cancelled || adopted) return;
      return runQuery(verseBootstrapQuery.key, verseBootstrapQuery.fetch).then(() => {
        if (!cancelled) markCheckComplete(getQuerySnapshot(verseBootstrapQuery.key).status === 'success');
      });
    });
    return () => { cancelled = true; };
  }, [phase]);
  if (phase === 'checking' || (phase === 'authenticated' && !surface)) {
    return <p className={styles.checking} role="status">Checking for an existing Phantom session…</p>;
  }
  if (phase === 'unauthenticated') {
    return (
      <Suspense fallback={<p className={styles.checking} role="status">Checking for an existing Phantom session…</p>}>
        <SessionGate heading={`Connect to ${PRODUCT_NAME}`} command="phm verse" subject={PRODUCT_NAME} mutationField />
      </Suspense>
    );
  }
  return (
    <ToastProvider>
      <SkipToContent />
      <div className={styles.shell}><VerseApp /></div>
    </ToastProvider>
  );
}
