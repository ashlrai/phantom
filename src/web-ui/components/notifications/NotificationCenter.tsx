/**
 * components/notifications/NotificationCenter.tsx — the attention queue
 * itself. Mount exactly once, anywhere always-rendered (Topbar, alongside
 * <NotificationBell/>) — it runs useNotificationEngine() unconditionally
 * (so the bell's badge count and any desktop alert can fire even while the
 * panel is closed) and only gates the visible panel on `panelOpen`.
 *
 * Built on the shared <Dialog/> primitive per DESIGN.md's component
 * convention ("if you need a new modal, extend Dialog, don't hand-roll
 * one") — `widthClassName` docks it to the right as a drawer instead of the
 * centered card Dialog uses by default, but focus trap / Escape / backdrop
 * click / return-focus all come for free.
 */
import { useRef, useState } from 'react';
import { Dialog } from '../primitives/Dialog.js';
import { NotificationItem } from './NotificationItem.js';
import { groupHeading, groupNotifications } from './notification-groups.js';
import type { NotificationCategory } from './types.js';
import { useNotifications } from './useNotifications.js';
import { useNotificationEngine } from './useNotificationEngine.js';
import { closePanel, enableDesktopNotifications, disableDesktopNotifications } from './notification-store.js';
import styles from './NotificationCenter.module.css';

export function NotificationCenter() {
  // Always runs, regardless of panelOpen — see header comment.
  useNotificationEngine();
  const { items, panelOpen, desktopEnabled, desktopPermission } = useNotifications();
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState<Set<NotificationCategory>>(() => new Set());

  function toggleGroup(category: NotificationCategory) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function toggleDesktop() {
    if (desktopEnabled) {
      disableDesktopNotifications();
    } else {
      const result = await enableDesktopNotifications();
      if (result === 'denied') {
        // Browser-level denial — nothing more we can do from here; the
        // toggle will simply reflect "off" next render.
      }
    }
  }

  return (
    <Dialog
      open={panelOpen}
      onClose={closePanel}
      titleId="notification-center-title"
      title={
        <span className={styles.titleRow}>
          <span>Notifications</span>
          <button type="button" ref={closeBtnRef} className={styles.closeBtn} onClick={closePanel} aria-label="Close notifications">
            ×
          </button>
        </span>
      }
      widthClassName={styles.drawer}
      initialFocusRef={closeBtnRef}
    >
      <div className={styles.header}>
        <button type="button" className={styles.desktopToggle} onClick={() => void toggleDesktop()} disabled={desktopPermission === 'unsupported' || desktopPermission === 'denied'}>
          {desktopPermission === 'unsupported'
            ? 'Desktop alerts not supported in this browser'
            : desktopPermission === 'denied'
              ? 'Desktop alerts blocked in browser settings'
              : desktopEnabled
                ? '🔔 Desktop alerts on'
                : '🔕 Desktop alerts off — enable'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className={styles.clear}>
          <strong>Nothing needs you right now.</strong>
          <span>The fleet is operating within its observed authority.</span>
        </div>
      ) : items.length > 6 ? (
        <div className={styles.list}>
          {groupNotifications(items).map((group) => (
            <section className={styles.group} key={group.category} aria-labelledby={`notification-group-${group.category}`}>
              <button
                type="button"
                id={`notification-group-${group.category}`}
                className={styles.groupHead}
                aria-expanded={!collapsed.has(group.category)}
                onClick={() => toggleGroup(group.category)}
              >
                {groupHeading(group)}
              </button>
              {!collapsed.has(group.category) && (
                <ul className={styles.list}>
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <NotificationItem item={item} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      ) : (
        <ul className={styles.list}>
          {items.map((item) => (
            <li key={item.id}>
              <NotificationItem item={item} />
            </li>
          ))}
        </ul>
      )}

      <a href="#/journal" className={styles.journalLink} onClick={closePanel}>
        See full history in the Work Journal →
      </a>
    </Dialog>
  );
}
