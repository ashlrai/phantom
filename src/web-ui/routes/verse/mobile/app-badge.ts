import { useEffect } from 'react';

export interface BadgeNavigator {
  setAppBadge?: (n?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

export function applyAppBadge(nav: BadgeNavigator | undefined, count: number | null): 'set' | 'cleared' | 'unsupported' | 'skipped' {
  if (!nav?.setAppBadge) return 'unsupported';
  if (count === null) return 'skipped';
  if (count === 0) {
    void (nav.clearAppBadge ? nav.clearAppBadge() : nav.setAppBadge(0)).catch(() => undefined);
    return 'cleared';
  }
  void nav.setAppBadge(count).catch(() => undefined);
  return 'set';
}

export function useAppBadge(count: number | null): void {
  useEffect(() => {
    applyAppBadge(typeof navigator === 'undefined' ? undefined : navigator, count);
  }, [count]);

  useEffect(() => () => {
    applyAppBadge(typeof navigator === 'undefined' ? undefined : navigator, 0);
  }, []);
}
