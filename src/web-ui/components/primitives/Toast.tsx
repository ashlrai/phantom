/**
 * components/primitives/Toast.tsx — app-wide notifications. A single
 * aria-live region so screen readers announce toasts once, not per-toast
 * duplicate regions.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import styles from './Toast.module.css';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastAction { label: string; onClick: () => void }

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  actions?: readonly ToastAction[];
}

interface ToastContextValue {
  show: (message: string, tone?: ToastTone, actions?: readonly ToastAction[]) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() called outside <ToastProvider>');
  return ctx;
}

const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'neutral', actions?: readonly ToastAction[]) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, tone, actions }]);
      if (!actions?.length) setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={styles.region} role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`${styles.toast} ${styles[t.tone]}`}>
            <span>{t.message}</span>
            {t.actions?.map(action => (
              <button key={action.label} type="button" className={styles.action} onClick={() => { action.onClick(); dismiss(t.id); }}>
                {action.label}
              </button>
            ))}
            <button type="button" className={styles.dismiss} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
