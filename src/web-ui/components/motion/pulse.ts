/**
 * components/motion/pulse.ts — the looping "still running" pulses (a dot that
 * breathes, a ring that spreads) played with the Web Animations API instead
 * of a CSS `animation: … infinite`.
 *
 * Why not CSS: React DOM listens on its root for every event it supports,
 * `animationiteration` included, and while a document has such a listener
 * Chromium wakes the main thread several times per iteration of EVERY
 * infinite CSS animation to dispatch it, even one that runs on the
 * compositor. Each wake is a style recalc, pre-paint, layerize and commit of
 * the whole page. With one chat running (sidebar dot, live line, chapter
 * rail) that was ~13 extra frames a second with nothing else happening. A Web
 * Animation fires no iteration events, so the same keyframes cost the main
 * thread nothing once started.
 *
 * Usage: `<span className={styles.dot} ref={RUNNING_RING} />`. A pulse is a
 * React 19 callback ref: it starts when the element mounts and is cancelled
 * when it unmounts. The same pulse may sit on any number of elements.
 *
 * Where: the sidebar's running dot, the live line, the chapter rail's running
 * tick and a running activity group. This module ships in the live line's
 * chunk; a pulse in a module that chunk's importers do not share (the
 * reasoning panes' ThinkingBlock, say) splits it into a chunk of its own,
 * whose name then lands in first-paint preload lists: check
 * `npm run check:first-paint` when adding one.
 *
 * Reduced motion follows the same two triggers as the CSS it replaces
 * (as charts/motion.ts `prefersReducedMotion` does): Settings' `data-motion` on
 * <html>, else the OS preference. Both are watched, so flipping either stops
 * or restarts every live pulse without a remount.
 */

export interface PulseSpec {
  keyframes: Keyframe[];
  /** One cycle, ms. */
  duration: number;
  /**
   * Applied between EACH pair of keyframes, as CSS `animation-timing-function`
   * is (a Web Animation's own `easing` would bend the whole cycle instead).
   */
  easing: string;
  /** Animate this pseudo-element of the node (e.g. '::after') rather than the node. */
  pseudoElement?: string;
}

export type PulseRef = (node: Element | null) => (() => void) | undefined;

interface Running {
  node: Element;
  spec: PulseSpec;
  animation: Animation | null;
}

const running = new Set<Running>();
let watching = false;

/** charts/motion.ts `prefersReducedMotion`, kept here so a pulse pulls in no chart code. */
function prefersReducedMotion(): boolean {
  const pref = document.documentElement.getAttribute('data-motion');
  if (pref === 'reduce' || pref === 'full') return pref === 'reduce';
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

function sync(entry: Running, reduce: boolean): void {
  if (reduce) {
    entry.animation?.cancel();
    entry.animation = null;
    return;
  }
  if (entry.animation) return;
  const { keyframes, duration, easing, pseudoElement } = entry.spec;
  entry.animation = entry.node.animate(keyframes.map((frame) => ({ easing, ...frame })), {
    duration,
    iterations: Infinity,
    ...(pseudoElement ? { pseudoElement } : {}),
  });
}

function syncAll(): void {
  const reduce = prefersReducedMotion();
  for (const entry of running) sync(entry, reduce);
}

function watch(): void {
  if (watching) return;
  watching = true;
  if (typeof MutationObserver === 'function') {
    new MutationObserver(syncAll).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  }
  try {
    window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', syncAll);
  } catch {
    // No media queries (or a legacy MediaQueryList): the attribute still applies.
  }
}

/** A callback ref that plays `spec` on its element for as long as it is mounted. */
export function pulse(spec: PulseSpec): PulseRef {
  return (node) => {
    // jsdom and very old engines have no Element.animate: the element is simply still.
    if (!node || typeof node.animate !== 'function') return undefined;
    watch();
    const entry: Running = { node, spec, animation: null };
    running.add(entry);
    sync(entry, prefersReducedMotion());
    return () => {
      running.delete(entry);
      entry.animation?.cancel();
      entry.animation = null;
    };
  };
}

/** The 1.6 s breathing of a running dot: `--duration-pulse` in tokens.css. */
export const PULSE_MS = 1600;
