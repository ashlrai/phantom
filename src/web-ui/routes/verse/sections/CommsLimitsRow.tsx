/**
 * routes/verse/sections/CommsLimitsRow.tsx — read-only Settings row for the
 * comms.toml confirmation (t1632u, t1618u). Outside sends stay drafts until
 * Mason sets `confirmedByMason = true` in comms.toml himself.
 *
 * Read only on purpose: this row issues one GET and has no control that writes
 * comms.toml or sets the flag. That flag is Mason's alone. A failed or
 * malformed read says "unknown" rather than guessing either way.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Tag } from '../../../components/primitives/index.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { apiGet } from '../../../data/client.js';
import { COMMS_CONFIRM_LINE, COMMS_TOML_PATH } from '../leader-thread/inbox-held-model.js';
import { Panel, SettingRow } from './SettingRow.js';

export const COMMS_LIMITS_PATH = '/api/verse/comms/owner-thread/comms-limits';

type CommsLimits =
  | { state: 'loading' }
  | { state: 'unknown' }
  | { state: 'known'; confirmed: boolean; path: string };

export function parseCommsLimits(value: unknown): CommsLimits {
  if (!value || typeof value !== 'object') return { state: 'unknown' };
  const row = value as Record<string, unknown>;
  if (row['schema'] !== 'comms.limits.v1' || typeof row['confirmedByMason'] !== 'boolean') return { state: 'unknown' };
  const path = typeof row['path'] === 'string' && row['path'].length > 0 ? row['path'] : COMMS_TOML_PATH;
  return { state: 'known', confirmed: row['confirmedByMason'], path };
}

export function CommsLimitsRow() {
  const [limits, setLimits] = useState<CommsLimits>({ state: 'loading' });
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<unknown>(COMMS_LIMITS_PATH, controller.signal)
      .then((value) => setLimits(parseCommsLimits(value)))
      .catch(() => { if (!controller.signal.aborted) setLimits({ state: 'unknown' }); });
    return () => controller.abort();
  }, []);

  async function copy(path: string): Promise<void> {
    setCopied((await copyText(path)) ? 'copied' : 'failed');
  }

  let tag: string;
  let description: ReactNode;
  if (limits.state === 'known' && limits.confirmed) {
    tag = 'Confirmed';
    description = 'Outside sends allowed within comms.toml limits.';
  } else if (limits.state === 'known') {
    tag = 'Not confirmed';
    description = (
      <>
        Outside sends are drafts only. To allow them, add <code>{COMMS_CONFIRM_LINE}</code> to <code>{limits.path}</code> yourself.
        {' '}
        <Button size="sm" variant="ghost" onClick={() => void copy(limits.path)}>Copy path</Button>
        {copied === 'copied' ? ' Copied.' : copied === 'failed' ? ' Copy failed: select the path and copy it manually.' : null}
      </>
    );
  } else if (limits.state === 'unknown') {
    tag = 'Unknown';
    description = 'Comms limits status is unknown: the local read did not answer. Outside sends stay drafts until it is confirmed.';
  } else {
    tag = 'Checking';
    description = 'Reading comms.toml…';
  }

  return (
    <Panel title="Comms limits">
      <SettingRow label="Confirmed by Mason" description={description}>
        <Tag size="sm" dot>{tag}</Tag>
      </SettingRow>
    </Panel>
  );
}
