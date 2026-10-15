import { useEffect, useState } from 'react';
import HintNavigation from '../../../src/web-ui/routes/verse/hints/HintNavigation.js';
import { setHintSettings, useHintSettings } from '../../../src/web-ui/routes/verse/hints/hint-settings.js';

/** This page imports the actual feature. All data, controls and draft text are synthetic. */
export function Fixture() {
  const settings = useHintSettings();
  const [compact, setCompact] = useState(false);
  const [textScale, setTextScale] = useState('1');
  useEffect(() => { document.documentElement.style.setProperty('--ui-text-scale', textScale); }, [textScale]);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const [draft, setDraft] = useState('Synthetic draft — keep this text.');
  const [pressed, setPressed] = useState(0);
  const [last, setLast] = useState('None');
  const [many, setMany] = useState(false);
  const [edges, setEdges] = useState(false);
  const [stacked, setStacked] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [dialogPartlyOutside, setDialogPartlyOutside] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [moved, setMoved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [semantic, setSemantic] = useState(false);
  const [clipped, setClipped] = useState(false);
  const press = (id: string) => { setPressed((n) => n + 1); setLast(id); };
  const schedule = (action: () => void) => window.setTimeout(action, 900);
  const reset = () => {
    setDraft('Synthetic draft — keep this text.'); setPressed(0); setLast('None');
    setMany(false); setEdges(false); setStacked(false); setDialog(false); setDialogPartlyOutside(false);
    setDisabled(false); setMoved(false); setRemoved(false); setSemantic(false); setClipped(false);
    setHintSettings({ enabled: false, chord: 'ctrl-alt-h' });
  };
  return <>
    <header><h1>Phantom keyboard hints</h1><p>Synthetic localhost verification. No real account, agent, app, messages or terminal.</p></header>
    <section className="settings" aria-label="Fixture settings">
      <label><input type="checkbox" checked={settings.enabled} onChange={(event) => setHintSettings({ ...settings, enabled: event.target.checked })} />Enable actual hint component</label>
      <label>Entry chord <select value={settings.chord} onChange={(event) => setHintSettings({ ...settings, chord: event.target.value === 'ctrl-shift-h' ? 'ctrl-shift-h' : 'ctrl-alt-h' })}><option value="ctrl-alt-h">Ctrl+Alt+H</option><option value="ctrl-shift-h">Ctrl+Shift+H</option></select></label>
<label>Fixture theme <select value={theme} onChange={(event) => setTheme(event.target.value === 'dark' ? 'dark' : 'light')}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label><input type="checkbox" checked={compact} onChange={(event) => setCompact(event.target.checked)} />Compact fixture layout</label>
      <label>Fixture text scale <select value={textScale} onChange={(event) => setTextScale(event.target.value)}><option value="1">100%</option><option value="1.5">150%</option></select></label>
      <button type="button" onClick={reset}>Reset synthetic fixture</button>
    </section>
    <section className="controls" style={{ display: compact ? 'none' : undefined }} aria-label="Probe controls (never hint targets)">
      <label><input type="checkbox" checked={many} onChange={(event) => setMany(event.target.checked)} />Two-letter labels</label>
      <label><input type="checkbox" checked={edges} onChange={(event) => setEdges(event.target.checked)} />Edge targets</label>
      <label><input type="checkbox" checked={stacked} onChange={(event) => setStacked(event.target.checked)} />Close targets</label>
      <label><input type="checkbox" checked={clipped} onChange={(event) => setClipped(event.target.checked)} />Clip one target</label>
      <button type="button" onClick={() => schedule(() => setMoved((value) => !value))}>Move target after 900 ms</button>
      <button type="button" onClick={() => schedule(() => setDisabled((value) => !value))}>Disable target after 900 ms</button>
      <button type="button" onClick={() => schedule(() => setRemoved((value) => !value))}>Remove target after 900 ms</button>
      <button type="button" onClick={() => schedule(() => setSemantic((value) => !value))}>Change target state after 900 ms</button>
      <button type="button" onClick={() => schedule(() => setDialog(true))}>Show dialog after 900 ms</button>
      <button type="button" onClick={() => schedule(() => { setDialogPartlyOutside(true); setDialog(true); })}>Show partly outside dialog after 900 ms</button>
      <button type="button" onClick={() => schedule(() => setHintSettings({ ...settings, enabled: false }))}>Disable hints after 900 ms</button>
    </section>
    <main>
      <label className="editor-label">Synthetic draft <textarea aria-label="Synthetic draft" value={draft} onChange={(event) => setDraft(event.target.value)} data-phantom-hint="fixture.a.editor" data-phantom-hint-action="focus" /></label>
      <div className={stacked ? 'target-grid stacked' : 'target-grid'}>
        {!removed ? <button type="button" disabled={disabled} aria-pressed={semantic} style={{ transform: moved ? 'translateX(24px)' : undefined }} data-phantom-hint="fixture.b.settings" data-phantom-hint-action="press" onClick={() => press('Settings')}>Synthetic Settings</button> : null}
        {['Preview', 'Commands', 'Files', 'Agents', 'History', 'Search', 'Help'].map((label, index) => <button key={label} type="button" data-phantom-hint={`fixture.${String.fromCharCode(99 + index)}.${label.toLowerCase()}`} data-phantom-hint-action="press" onClick={() => press(label)}>Synthetic {label}</button>)}
        {many ? Array.from({ length: 4 }, (_, index) => <button key={index} type="button" data-phantom-hint={`fixture.x.${index}`} data-phantom-hint-action="press" onClick={() => press(`Extra ${index + 1}`)}>Extra control {index + 1}</button>) : null}
      </div>
      <div className={clipped ? 'clip-container clipped' : 'clip-container'}><button type="button" data-phantom-hint="fixture.y.clipped" data-phantom-hint-action="press" onClick={() => press('Clip target')}>Clip target</button></div>
      <output aria-label="Synthetic activation result">Activations: {pressed}. Last: {last}.</output>
      <p>Only the synthetic editor and explicitly marked harmless buttons are targets. Probe controls are excluded.</p>
    </main>
    {edges ? <><button className="edge-right" type="button" aria-label="Right edge marker" data-phantom-hint="fixture.z.right" data-phantom-hint-action="press" onClick={() => press('Right edge')}>R</button><button className="edge-bottom" type="button" aria-label="Bottom edge marker" data-phantom-hint="fixture.z.bottom" data-phantom-hint-action="press" onClick={() => press('Bottom edge')}>B</button></> : null}
    {dialog ? <div role="dialog" aria-modal="true" aria-label="Synthetic harmless dialog" className={dialogPartlyOutside ? 'dialog partly-outside' : 'dialog'}><p>Harmless synthetic modal</p><button type="button" onClick={() => { setDialog(false); setDialogPartlyOutside(false); }}>Close synthetic dialog</button></div> : null}
    <HintNavigation />
  </>;
}
