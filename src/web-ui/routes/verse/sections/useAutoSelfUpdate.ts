import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useDesktopUpdates } from '../../../app/desktop-updates.js';
import { useToast } from '../../../components/primitives/Toast.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { workersQuery } from '../fleet/workers-card-queries.js';
import { useDocumentVisible, usePollWhileVisible } from '../shell/section-visibility.js';
import { applySelfUpdate } from './update-apply-client.js';
import { updateStatusQuery } from './update-status-queries.js';
import { autoPolicyEvent, decideAutoUpdate, describeAutoDecision, readAutoUpdateAttempt, readAutoUpdatePolicy, writeAutoUpdateAttempt } from './update-auto-model.js';

const listeners = new Set<() => void>();
let sentence = 'Auto-update off';
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useAutoUpdateSentence(): string { return useSyncExternalStore(subscribe, () => sentence); }
export function useAutoUpdatePolicy() {
  const [policy, setPolicy] = useState(readAutoUpdatePolicy);
  useEffect(() => {
    const update = () => setPolicy(readAutoUpdatePolicy());
    window.addEventListener(autoPolicyEvent, update); window.addEventListener('storage', update);
    return () => { window.removeEventListener(autoPolicyEvent, update); window.removeEventListener('storage', update); };
  }, []);
  return policy;
}
export function useAutoSelfUpdate(): void {
  const policy = useAutoUpdatePolicy();
  const [nowMs, setNowMs] = useState(Date.now);
  const visible = useDocumentVisible();
  const status = useQuery(updateStatusQuery, { enabled: visible && policy.enabled });
  const workers = useQuery(workersQuery, { enabled: visible && policy.enabled });
  const refetch = useRefetch(updateStatusQuery);
  const refetchWorkers = useRefetch(workersQuery);
  const native = useDesktopUpdates();
  const toast = useToast();
  const busy = useRef(false);
  usePollWhileVisible(() => { setNowMs(Date.now()); refetch(); refetchWorkers(); }, 60_000, { enabled: policy.enabled });
  useEffect(() => {
    if (!visible) return;
    const knownWorkers = workers.status === 'success' ? workers.data : null;
    const facts = status.status === 'success' ? status.data : null;
    const decision = decideAutoUpdate({ policy, status: facts, workers: knownWorkers, nativePhase: native?.phase,
      lastAttempt: readAutoUpdateAttempt(), nowMs });
    sentence = describeAutoDecision(decision, knownWorkers, nowMs); listeners.forEach(l => l());
    if (!decision.apply || busy.current || !facts || 'kind' in facts || !facts.originSha) return;
    const attempt = { originSha: facts.originSha, at: Date.now(), outcome: 'applying' };
    if (!writeAutoUpdateAttempt(attempt)) return;
    busy.current = true;
    void (async () => {
      try {
        const result = await applySelfUpdate();
        writeAutoUpdateAttempt({ ...attempt, outcome: result.kind });
        toast.show(result.kind === 'updated' ? `Phantom updated itself to ${result.toCommit.slice(0, 7)}; ${result.restart === 'sidecar' ? 'restarting' : 'restart required'}`
          : `Auto-update ${result.kind}${'reason' in result ? `: ${result.reason}` : ''}`, result.kind === 'updated' ? 'success' : 'neutral');
      } finally { busy.current = false; refetch(); }
    })();
  }, [policy, visible, status, workers, native?.phase, toast, refetch, nowMs]);
}
