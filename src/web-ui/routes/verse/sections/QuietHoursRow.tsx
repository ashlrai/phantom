import { useState } from 'react';
import { Switch } from '../../../components/primitives/index.js';
import { loadQuietHours, saveQuietHours, type QuietHours } from '../../../components/notifications/quiet-hours.js';
import { Panel, SettingRow } from './SettingRow.js';

export function QuietHoursRow() {
  const [value, setValue] = useState<QuietHours | null>(loadQuietHours);
  function update(next: QuietHours | null) {
    setValue(next);
    saveQuietHours(next);
  }
  return <Panel title="Notification quiet hours">
    <SettingRow label="Quiet hours" description="Pause routine notification banners during this local time window. Hard-limit requests still come through." stacked>
      <Switch aria-label="Quiet hours" checked={value !== null} onChange={on => update(on ? { start: '22:00', end: '07:00' } : null)} />
      {value && <>
        <label>Start <input aria-label="Quiet hours start" type="time" value={value.start} onChange={e => { if (e.target.value) update({ ...value, start: e.target.value }); }} /></label>
        <label>End <input aria-label="Quiet hours end" type="time" value={value.end} onChange={e => { if (e.target.value) update({ ...value, end: e.target.value }); }} /></label>
      </>}
    </SettingRow>
  </Panel>;
}
