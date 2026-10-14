/** Setup UI loads only after an explicit click; the tour chip requests nothing. */
import { lazy, Suspense, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
const WorkspaceSetupSheet = lazy(() => import('./workspace-setup/WorkspaceSetupSheet.js').then(module => ({ default: module.WorkspaceSetupSheet })));
export function WorkspaceSetupLauncher() {
  const [open, setOpen] = useState(false);
  return <>
    <Button size="sm" onClick={() => setOpen(true)}>Set up my workspace</Button>
    {open ? <Suspense fallback={<p role="status">Opening workspace setup…</p>}>
      <WorkspaceSetupSheet onClose={() => setOpen(false)} />
    </Suspense> : null}
  </>;
}
