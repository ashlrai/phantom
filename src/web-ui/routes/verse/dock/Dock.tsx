/**
 * routes/verse/dock/Dock.tsx — the chat's PANEL AREA: every registered pane
 * (Terminal, Browser, Changes, Files, Sources, Reasoning, Tasks, Context,
 * and whatever other units register) as tabs, one pane or two stacked
 * (SPEC-310C §3, unit C2; 3.16 workbench; contracts: shell/dock-catalog.ts,
 * panes/pane-registry.ts).
 *
 * THE CONTAINER, NOT THE PANES. Panes come from the pane REGISTRY: the dock
 * never imports a pane's code. A pane that is not registered (or whose
 * `when` says it does not apply to this chat) simply has no tab — its
 * persisted tab comes back when it does. Each pane renders inside its own
 * error boundary (a crash says so, with a retry, and takes nothing else
 * down) and Suspense boundary (a lazy pane is its own chunk).
 *
 * LAYOUT follows the window and the operator (dockPresentation):
 *   ≥ 1024px   beside the chat (`column`, 320px … 60% of the window, its
 *              left edge dragged or moved with ←/→) — or under it (`bottom`,
 *              its top edge dragged or moved with ↑/↓), the operator's pick;
 *   480–1023   a sheet over the chat from the right;
 *   < 480      a bottom sheet, 75vh.
 * Two panes split vertically ("Browser over Terminal"), their boundary
 * dragged or moved with ↑/↓. Every drag is coalesced to one state write per
 * animation frame, so resizing holds 60fps however heavy the panes are.
 *
 * KEEP-ALIVE. A pane stays mounted from the moment its tab opens until the
 * tab closes — hidden, not unmounted, when another tab is on top — so a
 * terminal keeps its scrollback and a browser its page. Each pane is told
 * whether it is visible, so it can stop timers while hidden.
 *
 * State (open, tabs, split, sizes, placement, each chat's layout) lives in
 * dock-store.ts and persists with the shell's v3 blob.
 */
import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ErrorInfo,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { ActionMenu, anchorBelow, type ActionMenuItem, type MenuAnchor } from '../chat/ActionMenu.js';
import { commandChord, formatChord } from '../shell/command-keys.js';
import { DOCK_LAYOUT, clampDockHeight, clampDockWidth, type DockPaneId, type DockPresentation } from '../shell/dock-catalog.js';
import { getPane, isPaneAvailable, paneChordLabel, panesFor, preloadPanes, usePanes, type PaneContext, type PaneProps, type RegisteredPane } from '../panes/index.js';
import {
  closeDock,
  closeDockTab,
  closeDockTabs,
  openDockPane,
  setDockHeight,
  setDockSplitRatio,
  setDockWidth,
  splitDock,
  toggleDockPlacement,
  useDock,
} from './dock-store.js';
import { CloseGlyph, PanelBottomGlyph, PanelRightGlyph, SplitGlyph } from './dock-icons.js';
import styles from './Dock.module.css';
import { useAgentWorkspace, WORKSPACE_PANES } from './agent-workspace.js';
import { paneLinkUrl } from './pane-link.js';

/** What every pane gets besides its own id, visibility and presentation (PaneProps minus those). */
export type DockPaneContext = Omit<PaneProps, 'paneId' | 'visible' | 'presentation' | 'requests'>;

export interface DockProps {
  presentation: DockPresentation;
  /** Window width, for the 60% cap. */
  windowWidth: number;
  /** The width the column takes (after the transcript's floor); column presentation only. */
  columnWidth: number;
  /** The widest the column may be dragged before the transcript drops under its floor. */
  columnMax?: number;
  /** The chat column's height, for the bottom panel's caps; bottom presentation only. */
  columnHeight?: number;
  /** The open chat and the host actions, handed to every pane. */
  pane: DockPaneContext;
}

/** A catalog command's chord as this platform prints it ("⌘N" / "Ctrl+N"), or null when it has none. */
function chordOf(id: string): string | null {
  const chord = commandChord(id);
  return chord ? formatChord(chord) : null;
}

/** The pane's title, or the id itself while its registration is not in (never a blank tab). */
function titleOf(id: DockPaneId): string {
  return getPane(id)?.title ?? id;
}

const KEY_STEP = 16;
const KEY_STEP_COARSE = 64;
const RATIO_STEP = 0.05;

/**
 * One write per animation frame while a handle is dragged: pointermove fires
 * faster than the screen refreshes, and each write re-lays-out the chat.
 */
function useFrameWriter(write: (value: number) => void): (value: number) => void {
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return useCallback((value: number) => {
    pending.current = value;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (pending.current !== null) write(pending.current);
      pending.current = null;
    });
  }, [write]);
}

export function Dock(props: DockProps) {
  const { presentation, windowWidth, columnWidth, columnMax = Number.POSITIVE_INFINITY, columnHeight = 0, pane: paneContext } = props;
  const { state, requests } = useDock();
  usePanes(); // re-render when a pane is registered, replaced or removed
  const workspace = useAgentWorkspace(paneContext.sessionId);
  const tiled = workspace && presentation === 'column' && WORKSPACE_PANES.some((id) => id === state.active);
  const panelRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<DockPaneId, HTMLButtonElement>());
  const idBase = useId();
  const [menu, setMenu] = useState<
    | { kind: 'add' | 'split'; anchor: MenuAnchor; from: HTMLElement }
    | { kind: 'tab'; pane: DockPaneId; anchor: MenuAnchor; from: HTMLElement }
    | null
  >(null);
  const [copyNotice, setCopyNotice] = useState<{ pane: DockPaneId; text: 'Copied' | 'Copy failed' } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequest = useRef(0);
  useEffect(() => () => {
    copyRequest.current += 1;
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);
  // Panes mount on first show and stay mounted while their tab is open.
  const [mounted, setMounted] = useState<ReadonlySet<DockPaneId>>(() => new Set(state.open && state.active ? [state.active] : []));

  const context: PaneContext = { sessionId: paneContext.sessionId, session: paneContext.session, roots: paneContext.roots };
  const tabs = (tiled ? [...new Set([...WORKSPACE_PANES, ...state.tabs])] : state.tabs).filter((id) => isPaneAvailable(id, context));
  const active = state.active !== null && tabs.includes(state.active) ? state.active : tabs[0] ?? null;
  const split = state.splitWith !== null && tabs.includes(state.splitWith) && state.splitWith !== active ? state.splitWith : null;
  // The tabs a close may take — the same rule the per-tab close button uses
  // (a workspace tile has none while the workspace is tiled).
  const closable = tabs.filter((id) => !tiled || !WORKSPACE_PANES.some((pane) => pane === id));
  const open = state.open && active !== null;
  const sheet = presentation === 'sheet' || presentation === 'bottom-sheet';
  const docked = !sheet;
  // Stacked panes only where there is height for two: not in a phone's sheet, not in the bottom row.
  const canSplit = !tiled && (presentation === 'column' || presentation === 'sheet');
  const showSplit = !tiled && split !== null && canSplit;

  useEffect(() => {
    if (!open) return;
    setMounted((prev) => {
      const want = (tiled ? [...WORKSPACE_PANES] : [active, split]).filter((p): p is DockPaneId => p !== null);
      const next = new Set([...prev].filter((p) => tabs.includes(p)));
      for (const p of want) next.add(p);
      if (next.size === prev.size && [...next].every((p) => prev.has(p))) return prev;
      return next;
    });
  }, [open, active, split, tiled, tabs.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps -- tabs is compared by content

  // The panel is open: fetch every pane's code now, so a tab's first click
  // renders in the same frame instead of flashing its skeleton.
  useEffect(() => {
    if (open) preloadPanes();
  }, [open]);

  // A sheet takes focus when it opens and gives it back when it closes; a
  // docked panel does not steal focus from the composer.
  useEffect(() => {
    if (!open || !sheet) return undefined;
    const before = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [open, sheet]);

  const onSheetKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!sheet) return;
    // Esc belongs to a terminal (vim, less, a REPL) when focus is in one.
    const inTerminal = event.target instanceof Element && event.target.closest('[data-dock-pane="terminal"]') !== null;
    if (event.key === 'Escape' && !inTerminal && !event.defaultPrevented) {
      event.preventDefault();
      closeDock();
      return;
    }
    if (event.key !== 'Tab' || inTerminal) return;
    const node = panelRef.current;
    if (!node) return;
    const focusable = Array.from(node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.closest('[hidden]'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }, [sheet]);

  if (!open) return null;

  async function copyPaneLink(pane: DockPaneId) {
    const request = ++copyRequest.current;
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    setCopyNotice(null);
    let text: 'Copied' | 'Copy failed' = 'Copy failed';
    try {
      const link = paneLinkUrl(pane, paneContext.sessionId, getPane(pane)?.needsSession ?? true);
      if (!link || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(link);
      text = 'Copied';
    } catch {
      // An unavailable or rejected clipboard is reported on the button.
    }
    if (request !== copyRequest.current) return;
    setCopyNotice({ pane, text });
    copyTimer.current = setTimeout(() => setCopyNotice(null), 1500);
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, pane: DockPaneId) {
    // The keyboard's context-menu keys open the same menu a right-click does.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      setMenu({ kind: 'tab', pane, anchor: anchorBelow(event.currentTarget, 'start'), from: event.currentTarget });
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      event.stopPropagation();
      void copyPaneLink(pane);
      return;
    }
    const i = tabs.indexOf(pane);
    let next: DockPaneId | undefined;
    if (event.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs[tabs.length - 1];
    else if ((event.key === 'Delete' || event.key === 'Backspace') && tabs.length > 0) {
      event.preventDefault();
      closeDockTab(pane);
      return;
    }
    if (!next) return;
    event.preventDefault();
    openDockPane(next);
    tabRefs.current.get(next)?.focus();
  }

  const available = panesFor(context);
  // One line per pane: the name is the item's whole accessible name. What a
  // pane is FOR is taught where it is needed — its empty state.
  const menuItem = (p: RegisteredPane, label: string, onSelect: () => void): ActionMenuItem => {
    const Icon = p.icon;
    return { id: p.id, label, icon: <Icon size={14} />, onSelect };
  };
  const closedPanes = available.filter((p) => !tabs.includes(p.id));
  const addItems: ActionMenuItem[] = closedPanes.map((p) => menuItem(p, p.title, () => openDockPane(p.id)));
  const splitItems: ActionMenuItem[] = [
    ...available.filter((p) => p.id !== active).map((p) => menuItem(p, `${p.title} below`, () => splitDock(p.id))),
    ...(split ? [{ id: 'unsplit', label: 'One pane', separated: true, onSelect: () => splitDock(null) }] : []),
  ];
  // A tab's right-click menu: the fleet workspace leaves a score of tabs
  // open, and the way back to one was one click per tab.
  const tabItems = (id: DockPaneId): ActionMenuItem[] => {
    const others = closable.filter((pane) => pane !== id);
    return [
      ...(closable.includes(id) ? [{ id: 'close', label: `Close ${titleOf(id)}`, onSelect: () => closeDockTab(id) }] : []),
      { id: 'close-others', label: 'Close other panes', disabled: others.length === 0, onSelect: () => closeDockTabs(others) },
      { id: 'close-all', label: 'Close all panes', separated: true, disabled: closable.length === 0, onSelect: () => closeDockTabs(closable) },
    ];
  };

  const toggleChord = chordOf('dock.toggle');
  const width = presentation === 'column' ? columnWidth : clampDockWidth(state.width, windowWidth);
  const height = clampDockHeight(state.height, columnHeight);
  const label = `Dock: ${titleOf(active!)}${showSplit ? ` over ${titleOf(split!)}` : ''}`;
  const style = presentation === 'bottom-sheet'
    ? { height: `${DOCK_LAYOUT.bottomSheetHeightVh}vh` }
    : presentation === 'bottom' ? { height } : { width };

  const panel = (
    <aside
      ref={panelRef}
      className={styles.dock}
      data-presentation={presentation}
      data-split={showSplit ? 'true' : undefined}
      aria-label={label}
      role={sheet ? 'dialog' : 'complementary'}
      aria-modal={sheet ? true : undefined}
      tabIndex={-1}
      style={style}
      onKeyDown={onSheetKeyDown}
    >
      {presentation === 'column' ? <WidthHandle width={width} windowWidth={windowWidth} columnMax={columnMax} /> : null}
      {presentation === 'bottom' ? <HeightHandle height={height} columnHeight={columnHeight} /> : null}
      {presentation === 'bottom-sheet' ? <span className={styles.grabber} aria-hidden="true" /> : null}
      {/* Beside the chat, the head runs under the macOS title bar: it drags the window like the chat header does. */}
      <div className={styles.head} data-app-region={presentation === 'column' ? 'drag' : undefined}>
        <div className={styles.tabs} role="tablist" aria-label="Dock panes" aria-multiselectable={tiled || undefined}>
          {tabs.map((id) => {
            const registered = getPane(id)!;
            const Icon = registered.icon;
            const title = registered.title;
            const selected = id === active;
            const below = id === split && showSplit;
            const key = paneChordLabel(registered);
            return (
              <div key={id} className={styles.tabWrap} data-selected={selected || undefined} data-below={below || undefined}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ kind: 'tab', pane: id, anchor: { x: event.clientX, y: event.clientY }, from: tabRefs.current.get(id) ?? event.currentTarget });
                }}>
                <button
                  ref={(node) => { if (node) tabRefs.current.set(id, node); else tabRefs.current.delete(id); }}
                  type="button"
                  role="tab"
                  id={`${idBase}-tab-${id}`}
                  aria-selected={tiled ? WORKSPACE_PANES.some((pane) => pane === id) : selected}
                  aria-controls={`${idBase}-pane-${id}`}
                  tabIndex={selected ? 0 : -1}
                  className={styles.tab}
                  onClick={() => openDockPane(id)}
                  onKeyDown={(event) => onTabKeyDown(event, id)}
                  title={below ? `${title} (lower pane)` : key ? `${title} (${key})` : undefined}
                >
                  <Icon size={14} />
                  <span className={styles.tabLabel}>{title}</span>
                </button>
                {selected ? <button type="button" className={styles.tabCopy}
                  aria-label={copyNotice?.pane === id ? copyNotice.text : `Copy link to ${title}`}
                  title={`Copy link to ${title}`} onClick={() => { void copyPaneLink(id); }}>
                  {copyNotice?.pane === id ? copyNotice.text : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7" /></svg>}
                </button> : null}
                {!tiled || !WORKSPACE_PANES.some((pane) => pane === id) ? <button type="button" className={styles.tabClose} aria-label={`Close ${title}`}
                  title={`Close ${title} (⇧: close others)`} tabIndex={-1}
                  onClick={(event) => { if (event.shiftKey) closeDockTabs(closable.filter((pane) => pane !== id)); else closeDockTab(id); }}>
                  <CloseGlyph size={12} />
                </button> : null}
              </div>
            );
          })}
        </div>
        <div className={styles.headActions}>
          {/* Always drawn (disabled when every pane is open) so the actions
              never shift when the last closed pane is added back. */}
          <button type="button" className={styles.iconButton} aria-label="Add a pane"
            title={closedPanes.length > 0 ? 'Add a pane' : 'Every pane is already open'} aria-haspopup="menu"
            aria-expanded={menu?.kind === 'add'} disabled={closedPanes.length === 0}
            onClick={(event) => setMenu({ kind: 'add', anchor: anchorBelow(event.currentTarget), from: event.currentTarget })}>
            <span className={styles.plus} aria-hidden="true">+</span>
          </button>
          {canSplit && splitItems.length > 0 ? (
            <button type="button" className={styles.iconButton} aria-label={showSplit ? 'Split: change or undo' : 'Split the dock'}
              title={showSplit ? 'Change the split' : 'Split: show a second pane below'} aria-haspopup="menu" aria-expanded={menu?.kind === 'split'}
              aria-pressed={showSplit}
              onClick={(event) => setMenu({ kind: 'split', anchor: anchorBelow(event.currentTarget), from: event.currentTarget })}>
              <SplitGlyph size={14} />
            </button>
          ) : null}
          {docked ? (
            <button type="button" className={styles.iconButton}
              aria-label={presentation === 'bottom' ? 'Move the dock beside the chat' : 'Move the dock below the chat'}
              title={presentation === 'bottom' ? 'Move beside the chat' : 'Move below the chat'} onClick={toggleDockPlacement}>
              {presentation === 'bottom' ? <PanelRightGlyph size={14} /> : <PanelBottomGlyph size={14} />}
            </button>
          ) : null}
          <button type="button" className={styles.iconButton} aria-label="Close the dock"
            title={`Close the dock${toggleChord ? ` (${toggleChord})` : ''}`} onClick={closeDock}>
            <CloseGlyph size={14} />
          </button>
        </div>
      </div>

      <div className={styles.body} data-workspace={tiled || undefined}>
        {tabs.filter((p) => mounted.has(p) || p === active || p === split || (tiled && WORKSPACE_PANES.some((id) => id === p))).map((id) => {
          const shown = tiled ? WORKSPACE_PANES.some((pane) => pane === id) : id === active || (id === split && showSplit);
          const position = id === active ? 'top' : id === split ? 'bottom' : 'hidden';
          return (
            <div
              key={id}
              id={`${idBase}-pane-${id}`}
              role="tabpanel"
              aria-labelledby={`${idBase}-tab-${id}`}
              className={styles.pane}
              data-dock-pane={id}
              data-position={shown ? position : 'hidden'}
              hidden={!shown}
              inert={!shown}
              style={shown && showSplit
                ? { flexBasis: `${(position === 'top' ? state.splitRatio : 1 - state.splitRatio) * 100}%`, order: position === 'top' ? 0 : 2 }
                : undefined}
            >
              {tiled ? <div className={styles.workspaceTitle}>{titleOf(id)}</div> : null}
              <PaneHost id={id} visible={shown} presentation={presentation} context={paneContext} requests={requests} />
            </div>
          );
        })}
        {showSplit ? <SplitHandle ratio={state.splitRatio} lower={titleOf(split!)} /> : null}
      </div>

      {menu ? (
        <ActionMenu
          label={menu.kind === 'tab' ? `${titleOf(menu.pane)} pane` : menu.kind === 'add' ? 'Add a pane' : 'Split the dock'}
          items={menu.kind === 'tab' ? tabItems(menu.pane) : menu.kind === 'add' ? addItems : splitItems}
          anchor={menu.anchor}
          returnFocus={menu.from}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </aside>
  );

  if (!sheet) return panel;
  return (
    <div className={styles.sheetLayer} data-presentation={presentation} data-dock-layer>
      <button type="button" className={styles.scrim} aria-label="Close the dock" tabIndex={-1} onClick={closeDock} />
      {panel}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One pane: its empty state, its boundary, its component
// ---------------------------------------------------------------------------

function PaneHost({ id, visible, presentation, context, requests }: {
  id: DockPaneId;
  visible: boolean;
  presentation: DockPresentation;
  context: DockPaneContext;
  requests: ReturnType<typeof useDock>['requests'];
}) {
  const [attempt, setAttempt] = useState(0);
  const registered = getPane(id);
  if (!registered) return null;
  if (registered.needsSession && context.sessionId === null) {
    const newChat = chordOf('chat.new');
    return (
      <EmptyState compact title={`Open a chat to use ${registered.title}`}
        body={`Pick a chat in the sidebar${newChat ? ` or start one with ${newChat}` : ''}. ${registered.description ?? `${registered.title} works in that chat's folders.`}`} />
    );
  }
  const Body = registered.component;
  return (
    // A new key per attempt (and per replacement): a fresh boundary AND a fresh lazy component.
    <PaneBoundary key={`${attempt}`} title={registered.title} onRetry={() => setAttempt((n) => n + 1)}>
      <Suspense fallback={<PaneLoading title={registered.title} />}>
        <Body {...context} paneId={id} visible={visible} presentation={presentation} requests={requests} />
      </Suspense>
    </PaneBoundary>
  );
}

/** The pane's shape while its chunk loads — lines, not a spinner, so nothing jumps when it lands. */
function PaneLoading({ title }: { title: string }) {
  return (
    <div className={styles.loading} role="status" aria-label={`Loading ${title}`}>
      <SkeletonLine width="42%" />
      <SkeletonLine width="78%" />
      <SkeletonLine width="64%" />
    </div>
  );
}

class PaneBoundary extends Component<{ title: string; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console, not the page: operator copy never carries a stack or a path.
    console.error(`[verse] ${this.props.title} pane failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <EmptyState compact tone="error" title={`${this.props.title} could not load`} body="The rest of the chat still works."
        action={<Button variant="subtle" size="sm" onClick={this.props.onRetry}>Try again</Button>} />
    );
  }
}

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * An edge drag that never re-renders React while it moves: each frame writes
 * the new size straight onto the panel (inline width / height), the chat
 * grid's CSS variable and the handle's aria-valuenow, and the store gets ONE
 * write on release. That is what keeps a resize at 60fps with a transcript,
 * a terminal and a browser all on screen.
 */
function useEdgeDrag({ axis, size, min, max, cssVar, commit }: {
  axis: 'x' | 'y';
  size: number;
  min: number;
  max: number;
  /** The chat grid's variable for this size (ChatSection reads it for the track). */
  cssVar: '--verse-dock-width' | '--verse-dock-height';
  commit: (value: number) => void;
}) {
  const drag = useRef<{ start: number; startSize: number; last: number | null; handle: HTMLElement; frame: number | null } | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => () => {
    if (drag.current?.frame != null) cancelAnimationFrame(drag.current.frame);
    document.body.removeAttribute('data-verse-resizing');
  }, []);

  function paint(handle: HTMLElement, value: number) {
    const panel = handle.parentElement;
    const host = panel?.parentElement;
    if (panel) panel.style[axis === 'x' ? 'width' : 'height'] = `${value}px`;
    host?.style.setProperty(cssVar, `${value}px`);
    handle.setAttribute('aria-valuenow', String(value));
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { start: axis === 'x' ? event.clientX : event.clientY, startSize: size, last: null, handle: event.currentTarget, frame: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    document.body.setAttribute('data-verse-resizing', axis === 'x' ? 'true' : 'row');
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    // Both panels grow AWAY from the chat: dragging the edge left (or up) by N adds N.
    const delta = d.start - (axis === 'x' ? event.clientX : event.clientY);
    d.last = Math.min(max, Math.max(min, Math.round(d.startSize + delta)));
    if (d.frame !== null) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = null;
      if (d.last !== null) paint(d.handle, d.last);
    });
  }
  function end() {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    document.body.removeAttribute('data-verse-resizing');
    if (!d) return;
    if (d.frame !== null) cancelAnimationFrame(d.frame);
    if (d.last !== null) commit(d.last);
  }
  return {
    dragging,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end },
  };
}

/** The column's left edge: drag, or ←/→ (⇧ for coarse), double-click for the default. */
function WidthHandle({ width, windowWidth, columnMax }: { width: number; windowWidth: number; columnMax: number }) {
  const max = Math.max(DOCK_LAYOUT.minWidth, Math.min(Math.floor(windowWidth * DOCK_LAYOUT.maxWidthFraction), columnMax));
  const { dragging, handlers } = useEdgeDrag({ axis: 'x', size: width, min: DOCK_LAYOUT.minWidth, max, cssVar: '--verse-dock-width', commit: setDockWidth });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width + step;
    else if (event.key === 'ArrowRight') next = width - step;
    else if (event.key === 'Home') next = DOCK_LAYOUT.minWidth;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    setDockWidth(Math.min(max, clampDockWidth(next, windowWidth)));
  }

  return (
    <div className={styles.widthHandle} role="separator" aria-orientation="vertical" aria-label="Resize the dock"
      aria-valuemin={DOCK_LAYOUT.minWidth} aria-valuemax={max} aria-valuenow={Math.round(width)} tabIndex={0}
      data-dragging={dragging || undefined} {...handlers}
      onDoubleClick={() => setDockWidth(DOCK_LAYOUT.defaultWidth)} onKeyDown={onKeyDown} />
  );
}

/** The bottom panel's top edge: drag, or ↑/↓ (⇧ for coarse), double-click for the default. */
function HeightHandle({ height, columnHeight }: { height: number; columnHeight: number }) {
  const max = clampDockHeight(Number.MAX_SAFE_INTEGER, columnHeight);
  const { dragging, handlers } = useEdgeDrag({ axis: 'y', size: height, min: DOCK_LAYOUT.minHeight, max, cssVar: '--verse-dock-height', commit: setDockHeight });

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_STEP_COARSE : KEY_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowUp') next = height + step;
    else if (event.key === 'ArrowDown') next = height - step;
    else if (event.key === 'Home') next = DOCK_LAYOUT.minHeight;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    setDockHeight(clampDockHeight(next, columnHeight));
  }

  return (
    <div className={styles.heightHandle} role="separator" aria-orientation="horizontal" aria-label="Resize the dock"
      aria-valuemin={DOCK_LAYOUT.minHeight} aria-valuemax={max} aria-valuenow={Math.round(height)} tabIndex={0}
      data-dragging={dragging || undefined} {...handlers}
      onDoubleClick={() => setDockHeight(DOCK_LAYOUT.defaultHeight)} onKeyDown={onKeyDown} />
  );
}

/** The boundary between the two stacked panes: drag, or ↑/↓. */
function SplitHandle({ ratio, lower }: { ratio: number; lower: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ top: number; height: number } | null>(null);
  const write = useFrameWriter(setDockSplitRatio);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const body = ref.current?.parentElement;
    if (!body) return;
    event.preventDefault();
    const rect = body.getBoundingClientRect();
    drag.current = { top: rect.top, height: rect.height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.height <= 0) return;
    write((event.clientY - d.top) / d.height);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowUp') { event.preventDefault(); setDockSplitRatio(ratio - RATIO_STEP); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setDockSplitRatio(ratio + RATIO_STEP); }
  }
  return (
    <div ref={ref} className={styles.splitHandle} role="separator" aria-orientation="horizontal"
      aria-label={`Resize: ${lower} below`} aria-valuemin={Math.round(DOCK_LAYOUT.splitRatio.min * 100)}
      aria-valuemax={Math.round(DOCK_LAYOUT.splitRatio.max * 100)} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
      style={{ order: 1 }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => setDockSplitRatio(DOCK_LAYOUT.splitRatio.default)} onKeyDown={onKeyDown} />
  );
}
