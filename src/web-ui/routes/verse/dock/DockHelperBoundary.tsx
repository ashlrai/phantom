import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportDesktopError } from '../../../lib/report-desktop-error.js';
import styles from './panes.module.css';

export class DockHelperBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(`[verse] dock helper failed: ${this.props.name}`);
    reportDesktopError(`dock-helper:${this.props.name}`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <span role="status" className={styles.muted}>A dock helper failed and was turned off for this session.</span>;
  }
}
