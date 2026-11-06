import { NO_FLEET_TEXT } from './no-fleet.js';
import styles from './fleet.module.css';

export function NoFleetNotice() {
  return <p role="status" className={styles.muted}>{NO_FLEET_TEXT}</p>;
}
