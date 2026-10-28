/**
 * routes/verse/sections/OpsSection.tsx : the Ops tray section: the desktop
 * command center. Takes no props, per the shell contract; its own lazy chunk
 * (the section glob in shell/section-modules.ts). Reached from the gear tray
 * and from ⌘K ("Open Ops").
 */
import { OpsView } from '../ops/OpsView.js';

export function OpsSection() {
  return <OpsView />;
}
