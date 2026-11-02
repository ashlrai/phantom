import { useEffect, useMemo, useState } from 'react';
import type { PaneProps } from '../panes/pane-registry.js';
import { nativeComputer } from './native-computer.js';

/** Read-only companion to the window's single consent/kill controller. */
export function ComputerPane({ visible }: PaneProps) {
  const [state, setState] = useState('awaiting status');
  const native = useMemo(() => nativeComputer(), []);
  useEffect(() => {
    if (!visible || !native) return;
    return native.onState((event) => setState(event.state));
  }, [visible, native]);
  return <section aria-label="Computer use status">
    <h3>Computer use</h3>
    <p>{native ? `Desktop control: ${state}.` : 'Computer use requires a supported Phantom desktop shell.'}</p>
    <p>App access requires your consent. Use the desktop control bar to pause, revoke access or stop all control.</p>
  </section>;
}
