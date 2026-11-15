import { useEffect, useRef, useState } from 'react';
import { postJobStop, stopFailureText, stopOutcomeText } from './job-stop-action.js';

export function useJobStop(job: string) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => { setText(''); }, [job]);
  const run = async (): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await postJobStop(job);
      setText(stopOutcomeText(result));
      return true;
    } catch (error) {
      setText(stopFailureText(error));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, text, run, clear: () => setText('') };
}
