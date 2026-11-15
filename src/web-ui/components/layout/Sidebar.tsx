/**
 * components/layout/Sidebar.tsx — grouped, hierarchical nav (foundation
 * brief item 3), reading NAV_GROUPS from app/nav-config.ts so it can never
 * drift from what the command palette offers. Its right edge is a
 * window-splitter handle (drag, arrow keys, double-click to reset); the
 * width persists via sidebar-width.ts.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { VerseMark } from '../../routes/verse/rail-icons.js';
import { NavLink, type NavLinkRenderProps } from 'react-router-dom';
import { NAV_GROUPS } from '../../app/nav-config.js';
import { SIDEBAR_STEP, SIDEBAR_STEP_COARSE, SIDEBAR_WIDTH, useSidebarWidth } from './sidebar-width.js';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const { width, setWidth, reset } = useSidebarWidth();
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width });

  // Escape/blur/unmount all end the drag; the window listeners are the
  // contract (pointer capture is best-effort), so a stuck drag cannot happen.
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e: globalThis.PointerEvent) => setWidth(origin.current.width + e.clientX - origin.current.x);
    const end = () => setDragging(false);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setWidth(origin.current.width);
      end();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', end);
    document.body.dataset['shellResizing'] = 'true';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', end);
      delete document.body.dataset['shellResizing'];
    };
  }, [dragging, setWidth]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    origin.current = { x: e.clientX, width };
    setDragging(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? SIDEBAR_STEP_COARSE : SIDEBAR_STEP;
    switch (e.key) {
      case 'ArrowRight': setWidth(width + step); break;
      case 'ArrowLeft': setWidth(width - step); break;
      case 'Home': setWidth(SIDEBAR_WIDTH.min); break;
      case 'End': setWidth(SIDEBAR_WIDTH.max); break;
      case 'Enter': reset(); break;
      default: return;
    }
    e.preventDefault();
  };

  return (
    <div
      className={styles.frame}
      data-dragging={dragging ? 'true' : undefined}
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <nav className={styles.sidebar} aria-label="Primary">
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            <VerseMark size={20} />
          </span>
          <span className={styles.brandName}>Phantom</span>
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.id} className={styles.group}>
            <h2 className={styles.groupLabel}>{group.label}</h2>
            <ul className={styles.leaves}>
              {group.leaves.map((leaf) => (
                <li key={leaf.path}>
                  <NavLink
                    to={leaf.path}
                    className={({ isActive }: NavLinkRenderProps) => `${styles.link} ${isActive ? styles.active : ''}`}
                  >
                    {leaf.label}
                    {!leaf.implemented ? <span className={styles.soon}>soon</span> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_WIDTH.min}
        aria-valuemax={SIDEBAR_WIDTH.max}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={reset}
      />
    </div>
  );
}
