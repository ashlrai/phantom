import { lazy, Suspense, useState } from 'react';

const FrictionDialog = lazy(() => import('./FrictionDialog.js'));

export function FrictionFeedback({ surface, className }: { surface: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  return <>
    <button type="button" className={className} aria-label="Improve this screen" title="Improve this screen"
      onClick={() => setOpen(true)}>⚑</button>
    <Suspense fallback={null}>{open && <FrictionDialog surface={surface} description={description} setDescription={setDescription} onClose={() => setOpen(false)} />}</Suspense>
  </>;
}
