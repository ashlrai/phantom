/**
 * routes/verse/sections/UpdatesPanel.tsx — Settings ▸ Updates. The desktop
 * update row and release gap live here, so their reads (and the origin fetch
 * on focus) start only when this group is open, not on every Settings open.
 */
import { Panel } from './SettingRow.js';
import { ReleaseGapRow } from './ReleaseGapRow.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

export function UpdatesPanel() {
  return (
    <Panel title="Updates">
      <div data-verse-anchor="desktop-updates">
        <UpdateStatusRow />
      </div>
      <ReleaseGapRow />
    </Panel>
  );
}
