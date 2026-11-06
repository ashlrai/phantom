/**
 * components/notifications/desktop-notification-click.ts — what happens when
 * an operator clicks an OS notification banner raised by the store. Kept as
 * a pure module (no DOM access of its own) so the navigation decision is
 * testable without a browser: the store resolves a `NotificationClickTarget`
 * for the AppNotification and injects every side effect (`window.focus`,
 * `location.hash`, `location.assign`, opening the bell panel) through `env`.
 *
 * Safety rule: a click never navigates to a non-http(s) scheme and never
 * leaves this console's origin — a foreign or unparseable actionHref degrades
 * to just opening the notification panel instead of trusting the URL.
 */
import type { AppNotification } from './types.js';

export type NotificationClickTarget =
  | { kind: 'run' }
  | { kind: 'hash'; hash: string }
  | { kind: 'url'; url: string }
  | { kind: 'panel' };

/**
 * Resolve what a desktop-notification click should do, in priority order:
 * `actionRun` beats any href (same as NotificationItem's button-over-link
 * rule); a hash-router path (`/verse/…`) becomes a `location.hash` write;
 * a same-origin absolute http(s) deep link becomes a full navigation;
 * anything else — no action, foreign origin, non-http(s) scheme — falls
 * back to opening the bell panel so the click is never dead.
 */
export function notificationClickTarget(
  n: Pick<AppNotification, 'actionHref' | 'actionRun'>,
  origin: string,
): NotificationClickTarget {
  if (n.actionRun) return { kind: 'run' };
  const href = n.actionHref;
  if (!href) return { kind: 'panel' };
  if (href.startsWith('/')) return { kind: 'hash', hash: `#${href}` };
  try {
    const url = new URL(href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin) {
      return { kind: 'url', url: href };
    }
  } catch {
    /* not an absolute URL — falls through to the panel fallback */
  }
  return { kind: 'panel' };
}

export interface NotificationClickEnv {
  focus(): void;
  setHash(hash: string): void;
  assign(url: string): void;
  openPanel(): void;
  run?: () => void;
}

/**
 * Attach the click behavior to a desktop Notification: focus the console
 * window first, act on the resolved target, then close the banner. The
 * notification param is structural so tests can pass a fake.
 */
export function attachNotificationClick(
  notification: {
    onclick: ((this: Notification, ev: Event) => unknown) | null;
    close(): void;
  },
  target: NotificationClickTarget,
  env: NotificationClickEnv,
): void {
  notification.onclick = () => {
    env.focus();
    switch (target.kind) {
      case 'run':
        env.run?.();
        break;
      case 'hash':
        env.setHash(target.hash);
        break;
      case 'url':
        env.assign(target.url);
        break;
      case 'panel':
        env.openPanel();
        break;
    }
    notification.close();
  };
}
