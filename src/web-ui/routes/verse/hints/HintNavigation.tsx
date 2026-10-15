import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { discoverHintTargets, HINT_ALPHABET, hintModalOpen, sameHintTargets, visibleHintBounds, type HintTarget } from './hint-model.js';
import { placeHintBadges } from './hint-placement.js';
import { matchesHintChord, useHintSettings } from './hint-settings.js';
import styles from './HintNavigation.module.css';

interface Session { targets: HintTarget[]; prefix: string; previous: HTMLElement | null; scope: readonly unknown[] }
function hintScope(): readonly unknown[] {
  const viewport = window.visualViewport;
  return [window.innerWidth, window.innerHeight, window.devicePixelRatio, viewport ?? null,
    viewport?.width, viewport?.height, viewport?.scale, viewport?.offsetLeft, viewport?.offsetTop,
    viewport?.pageLeft, viewport?.pageTop, document.fullscreenElement,
    window.screen.width, window.screen.height, window.screen.availWidth, window.screen.availHeight];
}
function sameScope(before: readonly unknown[]): boolean {
  const after = hintScope();
  return before.every((value, index) => Object.is(value, after[index]));
}
/** Scoped to this focused document. The overlay owns focus while modal; keys never reach a composer or xterm. */
export default function HintNavigation({ blocked = false }: { blocked?: boolean }) {
  const settings = useHintSettings();
  const [session, setSession] = useState<Session | null>(null);
  const current = useRef<Session | null>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const instructionsId = useId();
  const badgeNodes = useRef(new Map<string, HTMLSpanElement>());
  const statusNode = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState('');
  const configuration = useRef({ ...settings, blocked });
  configuration.current = { ...settings, blocked };

  const active = session !== null;
  useLayoutEffect(() => {
    if (!active) return;
    overlay.current?.focus({ preventScroll: true });
    if (document.activeElement !== overlay.current) {
      current.current = null; setSession(null); setNotice('Keyboard hints could not take focus. Try again.');
    }
  }, [active]);
  useLayoutEffect(() => {
    if (!session) return;
    const layout = () => {
      if (current.current?.targets !== session.targets) return;
      const measured = session.targets.map((target) => {
        const rect = badgeNodes.current.get(target.id)?.getBoundingClientRect();
        return { id: target.id, left: target.bounds.left, top: target.bounds.top, width: rect?.width ?? 0, height: rect?.height ?? 0 };
      });
      const status = statusNode.current?.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      // Keep annotations near their targets; the free instruction pill yields to them.
      const positions = placeHintBadges(measured, viewport);
      const caption = positions && status ? placeHintBadges([{ id: 'instructions', left: status.left, top: status.top, width: status.width, height: status.height }], viewport, positions)?.[0] : null;
      if (!positions || !caption) {
        const previous = session.previous;
        const restore = document.activeElement === overlay.current && document.hasFocus() && sameScope(session.scope) && !configuration.current.blocked && !hintModalOpen() && previous && visibleHintBounds(previous);
        current.current = null; setSession(null); setNotice('Controls are too crowded to label clearly. Try a larger window.');
        if (restore && previous) previous.focus({ preventScroll: true });
        return;
      }
      if (statusNode.current) {
        statusNode.current.style.width = `${caption.width}px`;
        statusNode.current.style.left = `${caption.left}px`;
        statusNode.current.style.top = `${caption.top}px`;
        statusNode.current.style.bottom = 'auto';
        statusNode.current.style.transform = 'none';
      }
      for (const position of positions) {
        const node = badgeNodes.current.get(position.id);
        if (node) { node.style.left = `${position.left}px`; node.style.top = `${position.top}px`; }
      }
    };
    layout();
    // Actual font loading/text scaling can resize annotations without moving targets.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(layout);
    for (const node of badgeNodes.current.values()) observer.observe(node);
    if (statusNode.current) observer.observe(statusNode.current);
    return () => observer.disconnect();
  }, [session]);
  useLayoutEffect(() => {
    if (current.current && (blocked || !settings.enabled)) { current.current = null; setSession(null); }
  }, [blocked, settings.enabled]);
  useEffect(() => {
    const held = new Set<string>();
    function end(restore = true) {
      const previous = current.current?.previous;
      current.current = null;
      setSession(null);
      if (restore && document.hasFocus() && !hintModalOpen() && !configuration.current.blocked && previous && visibleHintBounds(previous)) previous.focus({ preventScroll: true });
    }
    const valid = (active: Session) => sameScope(active.scope) && document.hasFocus() && document.activeElement === overlay.current && configuration.current.enabled && !configuration.current.blocked && !hintModalOpen() && sameHintTargets(active.targets, discoverHintTargets());
    const keyIdentity = (event: KeyboardEvent) => event.code || `key:${event.key.toLowerCase()}`;
    function take(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function onKey(event: KeyboardEvent) {
      if (event.repeat && held.has(keyIdentity(event))) { take(event); return; }
      const active = current.current;
      if (!active) {
        if (!configuration.current.enabled || configuration.current.blocked || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || !document.hasFocus() || document.activeElement?.closest('input[type="password"], [data-secure-input="true"]') || hintModalOpen() || !matchesHintChord(event, configuration.current.chord)) return;
        held.add(keyIdentity(event));
        take(event);
        const targets = discoverHintTargets();
        if (!targets.length) { setNotice('No supported visible Phantom controls.'); return; }
        const next = { targets, prefix: '', scope: hintScope(), previous: document.activeElement instanceof HTMLElement ? document.activeElement : null };
        current.current = next;
        setNotice('');
        setSession(next);
        return;
      }
      held.add(keyIdentity(event));
      take(event); // All modal keys, including Enter and modified chords, are owned here.
      if (!valid(active)) { end(); return; }
      if (event.key === 'Escape') { end(); return; }
      if (event.repeat) return;
      if (event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.key === 'Process') { end(false); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      if (event.ctrlKey || event.altKey || event.metaKey) { end(); return; }
      if (event.key === 'Backspace') {
        const next = { ...active, prefix: active.prefix.slice(0, -1) };
        current.current = next; setSession(next); return;
      }
      const letter = event.key.toLowerCase();
      if (letter.length !== 1 || !HINT_ALPHABET.includes(letter)) { end(); return; }
      const prefix = active.prefix + letter;
      const target = active.targets.find((candidate) => candidate.label === prefix);
      if (target) {
        // Revalidate immediately before semantic activation, never synthesize a coordinate click.
        if (!valid(active)) { end(); return; }
        end(false);
        if (target.action === 'press') target.element.click();
        else target.element.focus({ preventScroll: true });
      } else if (active.targets.some((candidate) => candidate.label.startsWith(prefix))) {
        const next = { ...active, prefix }; current.current = next; setSession(next);
      } else { end(); }
    }
    function onUp(event: KeyboardEvent) { if (held.delete(keyIdentity(event)) || current.current) take(event); }
    function onInput(event: Event) { if (current.current) take(event); }
    function onComposition(event: Event) { if (current.current) { take(event); end(false); } }
    function onChange() { if (current.current && !valid(current.current)) end(); }
    const cancel = () => end();
    const blur = () => { held.clear(); end(false); };
    const onFocus = (event: FocusEvent) => { if (current.current && event.target !== overlay.current) end(false); };
    const observer = new MutationObserver(onChange);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    // Geometry can change without an attribute mutation (font load, animation or async layout).
    const timer = window.setInterval(onChange, 100);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('beforeinput', onInput, true);
    window.addEventListener('compositionstart', onComposition, true);
    window.addEventListener('scroll', cancel, true);
    window.addEventListener('resize', cancel);
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', cancel);
    viewport?.addEventListener('scroll', cancel);
    document.addEventListener('fullscreenchange', cancel);
    window.addEventListener('blur', blur);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('visibilitychange', blur);
    return () => {
      held.clear(); end(false);
      observer.disconnect(); window.clearInterval(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('beforeinput', onInput, true);
      window.removeEventListener('compositionstart', onComposition, true);
      window.removeEventListener('scroll', cancel, true);
      window.removeEventListener('resize', cancel);
      viewport?.removeEventListener('resize', cancel);
      viewport?.removeEventListener('scroll', cancel);
      document.removeEventListener('fullscreenchange', cancel);
      window.removeEventListener('blur', blur);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('visibilitychange', blur);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  if (!session && !notice) return null;
  return createPortal(
    <div ref={overlay} className={styles.overlay} tabIndex={session ? -1 : undefined} role={session ? 'group' : undefined}
      aria-label={session ? 'Phantom keyboard hints' : undefined} aria-describedby={session ? instructionsId : undefined}>
      {session?.targets.map((target) => (
        <span key={target.id} ref={(node) => { if (node) badgeNodes.current.set(target.id, node); else badgeNodes.current.delete(target.id); }} data-hint-label={target.label} className={styles.hint} aria-hidden="true"
          style={{ left: target.bounds.left, top: target.bounds.top, visibility: target.label.startsWith(session.prefix) ? 'visible' : 'hidden' }}>{target.label.toUpperCase()}</span>
      ))}
      {session ? <ul className="visually-hidden" aria-label="Available keyboard hint targets">
        {session.targets.filter((target) => target.label.startsWith(session.prefix)).map((target) => <li key={target.id}>
          {target.label.toUpperCase()} — {target.action === 'focus' ? 'Focus' : 'Open'} {targetDescription(target.id)}
        </li>)}
      </ul> : null}
      <div ref={statusNode} id={instructionsId} className={styles.status} role="status">{session ? <>{session.targets.length} controls. Type a hint <span className={styles.prefix} aria-hidden={!session.prefix || undefined} style={{ width: `${(session.targets[0]?.label.length ?? 1) + 2}ch`, visibility: session.prefix ? 'visible' : 'hidden' }}>{`(${(session.prefix || session.targets[0]?.label || '').toUpperCase()})`}</span> · Escape cancels</> : notice}</div>
    </div>, document.body,
  );
}

/** Accessible descriptions use app-owned identities, never private target contents. */
function targetDescription(id: string): string {
  if (id.startsWith('terminal.input.')) return 'terminal input';
  if (id.startsWith('terminal.tab.')) return 'terminal tab';
  if (id.startsWith('preview.tab.')) return 'preview tab';
  return id.replace(/[._-]/g, ' ');
}
