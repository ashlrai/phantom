/** InterjectReceipt — one proof line under the latest sent interjection. Reads the
 * bus page the rail already polls (no new polling loop). */
import { useMemo, useSyncExternalStore } from 'react';
import { getLatestAgentBusPage, subscribeAgentBusPage } from './fleet-bus/agent-bus-queries.js';
import { buildInterjectReceipt, type InterjectSend } from './interject-receipt.js';
import styles from './Composer.module.css';

export function InterjectReceipt({ send }: { send: InterjectSend }) {
  const page = useSyncExternalStore(subscribeAgentBusPage, getLatestAgentBusPage, getLatestAgentBusPage);
  const receipt = useMemo(() => buildInterjectReceipt(send, page?.messages ?? [], Date.now()), [send, page]);
  const failed = receipt.state === 'failed';
  return <p role="status" data-testid="interject-receipt" data-state={receipt.state}
    className={`${styles.help} ${failed ? styles.helpError : ''}`}>{receipt.text}</p>;
}
