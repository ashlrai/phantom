import { NotificationBell } from '../../../components/notifications/NotificationBell.js';
import { NotificationCenter } from '../../../components/notifications/NotificationCenter.js';
import { Tooltip } from '../../../components/primitives/Tooltip.js';
import styles from '../VerseApp.module.css';

export function ConsoleBell({ expanded, compact }: { expanded: boolean; compact: boolean }) {
  return (
    <Tooltip label="Notifications" placement="right" disabled={expanded || compact}>
      <label className={styles.railButton}>
        <NotificationBell />
        {expanded || compact ? <span className={styles.railLabel}>Notifications</span> : null}
      </label>
    </Tooltip>
  );
}

export function ConsoleNotificationCenter() {
  return <NotificationCenter />;
}
