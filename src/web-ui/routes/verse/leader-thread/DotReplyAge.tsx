/**
 * routes/verse/leader-thread/DotReplyAge.tsx — the Leader thread header's one
 * line answering "did Dot's last iMessage get a reply, and how old is it":
 * `Dot: last text 4 min ago, answered` or `… NOT answered`, urgent once the
 * wait reaches ten minutes. Read-only: it polls the teammate reply-age route
 * and shows nothing at all until a read has answered.
 */
import { ApiError, apiGet } from '../../../data/client.js';
import { useEffect, useState } from 'react';
import type { QueryDef } from '../../../data/queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import leaderStyles from '../leader/leader.module.css';
import { dotReplyAge, type DotReplyAgeRead } from './DotReplyAge.model.js';

export const DOT_REPLY_AGE_PATH = '/api/verse/comms/teammate-reply-age';

/** The route may not be served by this build; a 404 means "unknown", never an error state. */
export const dotReplyAgeQuery: QueryDef<DotReplyAgeRead | null> = {
  key: 'verse-comms-teammate-reply-age',
  fetch: async signal => {
    try {
      return await apiGet<DotReplyAgeRead>(DOT_REPLY_AGE_PATH, signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export function DotReplyAge({ visible = true }: { visible?: boolean }) {
  const [read, setRead] = useState<DotReplyAgeRead | null | undefined>(undefined);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let controller: AbortController | undefined;
    const poll = () => {
      controller?.abort();
      controller = new AbortController();
      void dotReplyAgeQuery.fetch(controller.signal).then(value => {
        if (active) setRead(value);
      }, () => { if (active) setRead(null); });
    };
    poll();
    const timer = window.setInterval(poll, 30_000);
    return () => { active = false; window.clearInterval(timer); controller?.abort(); };
  }, [visible]);
  const now = useNow(10_000);
  if (read === undefined) return null;
  const view = dotReplyAge(read, now);
  return (
    <span
      className={leaderStyles.channel}
      role="status"
      data-dot-reply={view.bucket}
      style={view.bucket === 'late' ? { borderColor: 'var(--status-danger-solid)', color: 'var(--status-danger-fg)' } : undefined}
    >{view.text}</span>
  );
}
