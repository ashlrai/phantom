import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { consoleLayoutForWidth } from '../src/web-ui/app/console-mode.js';

function css(name: string): string {
  return readFileSync(new URL(`../src/web-ui/components/layout/${name}.module.css`, import.meta.url), 'utf8');
}

describe('operator-console narrow and reduced-motion contracts', () => {
  it('reflows the fixed desktop shell at a breakpoint that includes 320px', () => {
    // app/console-mode.ts resolves the width classes and stamps
    // data-console-layout on <html>; the compact class covers every width
    // below 720px, including 320px.
    expect(consoleLayoutForWidth(320)).toBe('compact');
    const shell = css('Shell');
    const sidebar = css('Sidebar');
    const topbar = css('Topbar');
    expect(shell).toMatch(/data-console-layout='compact'\]\s*\.shell\s*\{[^}]*flex-direction:\s*column/);
    expect(sidebar).toMatch(/data-console-layout='compact'\]\s*\.sidebar\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/);
    expect(sidebar).toMatch(/\.link\s*\{[^}]*min-height:\s*44px/);
    expect(topbar).toMatch(/data-console-layout='compact'\]\s*\.paletteTrigger\s*\{[^}]*min-width:\s*0/);
    expect(topbar).toMatch(/data-console-layout='compact'\][\s\S]*?min-height:\s*44px/);
  });

  it('removes navigation and command-trigger transitions for reduced motion', () => {
    expect(css('Sidebar')).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/);
    expect(css('Topbar')).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition:\s*none/);
  });
});
